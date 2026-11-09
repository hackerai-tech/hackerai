import "server-only";

import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import type { AnySandbox } from "@/types";
import {
  getSandboxLogFields,
  isCentrifugoSandbox,
  isE2BSandbox,
} from "./sandbox-types";
import { getSandboxFileName } from "./platform-utils";
import { buildSandboxCommandOptions } from "./sandbox-command-options";
import { generateS3UploadUrl } from "@/convex/s3Utils";
import { getConvexClient } from "@/lib/db/convex-client";
import {
  MAX_GENERATED_FILE_SIZE_BYTES,
  type S3StorageLocation,
  type S3StorageRegion,
} from "@/lib/constants/s3";
import { logger } from "@/lib/logger";
import { getLocalFileRequestFailure } from "./local-sandbox-errors";
import { SandboxFileNotFoundError } from "./sandbox-file-errors";
import {
  buildPosixCurlUploadCommand,
  getUploadFailureDiagnostics,
} from "./sandbox-upload-diagnostics";

const DEFAULT_MEDIA_TYPE = "application/octet-stream";
const MAX_GENERATED_FILE_SIZE_MB =
  MAX_GENERATED_FILE_SIZE_BYTES / (1024 * 1024);
const SANDBOX_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const SANDBOX_UPLOAD_STATUS_MARKER = "__HACKERAI_UPLOAD_EXIT_CODE__:";
const WINDOWS_FILE_SIZE_PATH_ENV_VAR = "HACKERAI_FILE_SIZE_PATH";
const UNSUPPORTED_WINDOWS_FILE_SIZE_PATH_CHARS = /[\0"!\r\n^]/;

export type UploadedFileInfo = {
  url: string;
  fileId: Id<"files">;
  tokens: number;
  // Metadata for file accumulator (avoids re-querying DB)
  name: string;
  mediaType: string;
  s3Key?: string;
  sizeBytes: number;
};

export type GeneratedFileUploadPhase =
  "file_metadata" | "upload_url" | "transfer" | "file_registration";

export type NativeStatFailureReason =
  "stat_failed" | "file_missing" | "not_regular_file" | "invalid_file_size";

export type GeneratedFileTransferAttemptFailure = ReturnType<
  typeof getUploadFailureDiagnostics
> & {
  transfer_attempt_kind: "native" | "command";
  transfer_exit_code: number | null;
  sandbox_type: "cloud" | "desktop" | "remote-connection";
};

/**
 * Mint a fresh, user-scoped download URL for a previously uploaded sandbox
 * file. Presigned S3 URLs are intentionally not persisted in tool output
 * because they expire; the stable file ID is persisted instead.
 */
export async function getSandboxUploadedFileUrl(args: {
  fileId: Id<"files">;
  userId: string;
}): Promise<string | undefined> {
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is required for sandbox file downloads",
    );
  }

  if (!process.env.CONVEX_SERVICE_ROLE_KEY) {
    throw new Error(
      "CONVEX_SERVICE_ROLE_KEY is required for sandbox file downloads. " +
        "This is a server-only secret and must never be exposed to the client.",
    );
  }

  const urls = await getConvexClient().action(
    api.s3Actions.getFileUrlsByFileIdsAction,
    {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY,
      userId: args.userId,
      fileIds: [args.fileId],
    },
  );

  return urls[0] ?? undefined;
}

/**
 * Extract error message from ConvexError or regular Error
 * Ensures user-friendly error messages are properly displayed
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const errorData = error.data as { message?: string };
    return errorData?.message || error.message || "An error occurred";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function shouldUseWindowsFileSizeCommand(
  sandbox: AnySandbox,
): Promise<boolean> {
  return (
    isCentrifugoSandbox(sandbox) &&
    (await sandbox.detectShell()) === "cmd" &&
    sandbox.isWindows()
  );
}

function formatUnsupportedWindowsPathCharacter(character: string): string {
  switch (character) {
    case "\0":
      return "\\0";
    case "\r":
      return "\\r";
    case "\n":
      return "\\n";
    default:
      return character;
  }
}

function assertWindowsFileSizeFallbackPathSafe(fullPath: string): void {
  const unsupportedCharacter = fullPath.match(
    UNSUPPORTED_WINDOWS_FILE_SIZE_PATH_CHARS,
  )?.[0];
  if (!unsupportedCharacter) return;

  throw new Error(
    `Cannot safely get file size for Windows path containing unsupported character ${formatUnsupportedWindowsPathCharacter(unsupportedCharacter)}.`,
  );
}

function formatFileSizeFailure(
  fullPath: string,
  statResult: SandboxCommandResult,
): Error {
  const details = [statResult.stderr, statResult.stdout]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join("; ");

  return new Error(
    `Failed to get file size for ${fullPath}: ${
      details || `stat command failed with exit code ${statResult.exitCode}`
    }`,
  );
}

async function getSandboxFileSize(
  sandbox: AnySandbox,
  fullPath: string,
  onNativeStatFailure?: (
    reason: NativeStatFailureReason,
  ) => void | Promise<void>,
): Promise<number> {
  if (isCentrifugoSandbox(sandbox) && sandbox.supportsNativeFileRelay?.()) {
    // Desktop already provides shell-independent metadata. A POSIX stat or
    // cmd.exe fallback can fail even when the native bridge can read the file.
    // Preserve native errors instead of bypassing them through another adapter.
    let failureReason: NativeStatFailureReason = "stat_failed";
    try {
      const metadata = await sandbox.files.stat(fullPath);
      if (metadata.kind === "missing") {
        failureReason = "file_missing";
        throw new SandboxFileNotFoundError(fullPath);
      }
      if (metadata.kind !== "file") {
        failureReason = "not_regular_file";
        throw new Error(`Cannot upload ${fullPath}: not a regular file`);
      }
      if (
        typeof metadata.sizeBytes !== "number" ||
        !Number.isSafeInteger(metadata.sizeBytes) ||
        metadata.sizeBytes < 0
      ) {
        failureReason = "invalid_file_size";
        throw new Error("Desktop file bridge returned an invalid file size");
      }
      return metadata.sizeBytes;
    } catch (error) {
      if (onNativeStatFailure) {
        try {
          void Promise.resolve(onNativeStatFailure(failureReason)).catch(
            () => {},
          );
        } catch {
          // Optional observers must preserve the original native failure.
        }
      }
      try {
        logger.warn("sandbox_generated_file_native_stat_failed", {
          event: "sandbox_generated_file_native_stat_failed",
          service: "chat-handler",
          ...getSandboxLogFields(sandbox),
          failure_reason: failureReason,
          ...(failureReason === "stat_failed" && {
            native_stat_error_category: getLocalFileRequestFailure(error),
          }),
        });
      } catch {
        // Diagnostics must preserve the original metadata failure.
      }
      throw error;
    }
  }

  if (await shouldUseWindowsFileSizeCommand(sandbox)) {
    return getWindowsSandboxFileSize(sandbox, fullPath);
  }

  const quotedPath = shellQuote(fullPath);
  const commandOptions = buildSandboxCommandOptions(sandbox);
  let statResult: SandboxCommandResult;
  try {
    statResult = await sandbox.commands.run(
      `if [ ! -e ${quotedPath} ] && [ ! -L ${quotedPath} ]; then printf 'File not found: %s\\n' ${quotedPath} >&2; exit 66; fi; stat -Lc%s ${quotedPath} 2>/dev/null || stat -Lf%z ${quotedPath}`,
      { ...commandOptions, displayName: "" } as typeof commandOptions & {
        displayName?: string;
      },
    );
  } catch (error) {
    const commandResult = commandErrorToResult(error);
    if (!commandResult) {
      logger.error(
        "sandbox_generated_file_size_command_threw",
        error instanceof Error ? error : undefined,
        {
          event: "sandbox_generated_file_size_command_threw",
          service: "chat-handler",
          ...getSandboxLogFields(sandbox),
          file_name: getFileNameFromPath(sandbox, fullPath),
          file_path: fullPath,
          error: errorToLog(error),
        },
      );
      throw error;
    }
    statResult = commandResult;
  }

  const fileSize = parseInt(statResult.stdout.trim(), 10);
  if (!isNaN(fileSize) && statResult.exitCode === 0) {
    return fileSize;
  }

  logger.error("sandbox_generated_file_size_failed", undefined, {
    event: "sandbox_generated_file_size_failed",
    service: "chat-handler",
    ...getSandboxLogFields(sandbox),
    file_name: getFileNameFromPath(sandbox, fullPath),
    file_path: fullPath,
    stat_exit_code: statResult.exitCode,
    stat_stderr: statResult.stderr?.slice(0, 500),
    stat_stdout: statResult.stdout?.slice(0, 500),
  });
  // The metadata command reserves 66 for its explicit missing-file check.
  // Other stat failures do not prove that a different path is safe to use.
  if (statResult.exitCode === 66) throw new SandboxFileNotFoundError(fullPath);
  throw formatFileSizeFailure(fullPath, statResult);
}

async function getWindowsSandboxFileSize(
  sandbox: AnySandbox,
  fullPath: string,
): Promise<number> {
  const commandOptions = buildSandboxCommandOptions(sandbox);

  assertWindowsFileSizeFallbackPathSafe(fullPath);

  // The relay may set env vars earlier in the same cmd.exe /C command.
  // Enable delayed expansion in a child: inline SETLOCAL has no effect outside
  // a batch file. Keep the path in env so shell metacharacters remain data.
  // Resolve the child interpreter from Windows itself. A bare `cmd` can run a
  // cmd.bat supplied by the project in the relay's working directory.
  const winCommand = `"%SystemRoot%\\System32\\cmd.exe" /d /v:on /s /c "for %I in ("!${WINDOWS_FILE_SIZE_PATH_ENV_VAR}!") do @echo %~zI"`;
  let winResult: SandboxCommandResult;
  try {
    winResult = await sandbox.commands.run(winCommand, {
      ...commandOptions,
      envVars: {
        ...(commandOptions.envVars ?? {}),
        [WINDOWS_FILE_SIZE_PATH_ENV_VAR]: fullPath,
      },
      displayName: "",
    } as typeof commandOptions & {
      displayName?: string;
    });
  } catch (error) {
    const commandResult = commandErrorToResult(error);
    if (!commandResult) {
      logger.error(
        "sandbox_generated_file_size_windows_command_threw",
        error instanceof Error ? error : undefined,
        {
          event: "sandbox_generated_file_size_windows_command_threw",
          service: "chat-handler",
          ...getSandboxLogFields(sandbox),
          file_name: getFileNameFromPath(sandbox, fullPath),
          file_path: fullPath,
          error: errorToLog(error),
        },
      );
      throw error;
    }
    winResult = commandResult;
  }
  const fileSize = parseInt(winResult.stdout.trim(), 10);
  if (!isNaN(fileSize) && winResult.exitCode === 0) {
    return fileSize;
  }

  logger.error("sandbox_generated_file_size_failed", undefined, {
    event: "sandbox_generated_file_size_failed",
    service: "chat-handler",
    ...getSandboxLogFields(sandbox),
    file_name: getFileNameFromPath(sandbox, fullPath),
    file_path: fullPath,
    windows_exit_code: winResult.exitCode,
    windows_stderr: winResult.stderr?.slice(0, 500),
    windows_stdout: winResult.stdout?.slice(0, 500),
  });
  throw formatFileSizeFailure(fullPath, winResult);
}

function assertSandboxFileSizeAllowed(fileName: string, size: number): void {
  if (size <= MAX_GENERATED_FILE_SIZE_BYTES) return;

  throw new Error(
    `File "${fileName}" exceeds the maximum generated file size limit of ${MAX_GENERATED_FILE_SIZE_MB} MB. Current size: ${(size / (1024 * 1024)).toFixed(2)} MB`,
  );
}

function errorToLog(error: unknown) {
  if (error instanceof Error) {
    const commandError = error as Error & {
      exitCode?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      name: error.name,
      message: error.message,
      ...(typeof commandError.exitCode === "number"
        ? { exit_code: commandError.exitCode }
        : {}),
      ...(typeof commandError.stderr === "string" && commandError.stderr
        ? { stderr: commandError.stderr.slice(0, 500) }
        : {}),
      ...(typeof commandError.stdout === "string" && commandError.stdout
        ? { stdout: commandError.stdout.slice(0, 500) }
        : {}),
    };
  }
  return { message: String(error) };
}

function getFileNameFromPath(sandbox: AnySandbox, fullPath: string): string {
  return getSandboxFileName(
    fullPath,
    isCentrifugoSandbox(sandbox) && sandbox.isWindows(),
  );
}

type SandboxCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function commandErrorToResult(error: unknown): SandboxCommandResult | null {
  if (!(error instanceof Error)) return null;

  const commandError = error as Error & {
    exitCode?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };

  if (typeof commandError.exitCode !== "number") return null;

  return {
    stdout:
      typeof commandError.stdout === "string"
        ? commandError.stdout
        : error.message,
    stderr: typeof commandError.stderr === "string" ? commandError.stderr : "",
    exitCode: commandError.exitCode,
  };
}

function parseUploadResult(result: SandboxCommandResult): SandboxCommandResult {
  const statusMatch = result.stdout.match(
    new RegExp(`(?:^|\\n)${SANDBOX_UPLOAD_STATUS_MARKER}(\\d+)(?:\\n|$)`),
  );

  if (!statusMatch) return result;

  return {
    stdout: result.stdout
      .replace(
        new RegExp(`(?:^|\\n)${SANDBOX_UPLOAD_STATUS_MARKER}\\d+(?:\\n|$)`),
        "\n",
      )
      .trim(),
    stderr: result.stderr,
    exitCode: Number(statusMatch[1]),
  };
}

function formatUploadFailure(
  fullPath: string,
  result: SandboxCommandResult,
): Error {
  return new Error(
    `Failed to upload file ${fullPath}: ${
      result.stderr ||
      result.stdout ||
      `upload command failed with exit code ${result.exitCode}`
    }`,
  );
}

async function uploadGeneratedFileFromSandboxToUrl(args: {
  sandbox: AnySandbox;
  fullPath: string;
  uploadUrl: string;
  mediaType: string;
  onFailure?: (
    failure: GeneratedFileTransferAttemptFailure,
  ) => void | Promise<void>;
}): Promise<void> {
  const { sandbox, fullPath, uploadUrl, mediaType } = args;
  const fileName = getFileNameFromPath(sandbox, fullPath);
  const sandboxType = getSandboxLogFields(sandbox).sandbox_type;
  const reportFailure = (
    kind: GeneratedFileTransferAttemptFailure["transfer_attempt_kind"],
    error: unknown,
    exitCode: number | null = null,
  ) => {
    if (!args.onFailure) return;
    // A failed diagnostic getter must not hide an uncertain attempt from the
    // signature refresh decision. Still report it once with an unknown exit.
    try {
      if (
        exitCode === null &&
        error instanceof Error &&
        "exitCode" in error &&
        typeof error.exitCode === "number"
      ) {
        exitCode = error.exitCode;
      }
    } catch {
      exitCode = null;
    }
    try {
      void Promise.resolve(
        args.onFailure({
          transfer_attempt_kind: kind,
          sandbox_type: sandboxType,
          transfer_exit_code:
            typeof exitCode === "number" &&
            Number.isInteger(exitCode) &&
            exitCode >= 0 &&
            exitCode <= 255
              ? exitCode
              : null,
          ...getUploadFailureDiagnostics(uploadUrl, error),
        }),
      ).catch(() => {
        // Optional analytics must not replace the upload's result or error.
      });
    } catch {
      // Preserve frozen/native errors and the existing fallback decision.
    }
  };

  if (
    !isE2BSandbox(sandbox) &&
    "uploadToUrl" in sandbox.files &&
    typeof sandbox.files.uploadToUrl === "function"
  ) {
    try {
      await sandbox.files.uploadToUrl(fullPath, uploadUrl, mediaType);
      return;
    } catch (error) {
      reportFailure("native", error);
      logger.warn("sandbox_generated_file_native_upload_failed", {
        event: "sandbox_generated_file_native_upload_failed",
        service: "chat-handler",
        ...getSandboxLogFields(sandbox),
        file_name: fileName,
        file_path: fullPath,
        media_type: mediaType,
        ...getUploadFailureDiagnostics(uploadUrl, error),
        error: errorToLog(error),
      });
      // The Windows adapter already selected its available HTTP client. The
      // fallback below requires a POSIX shell and cannot recover that failure.
      if (isCentrifugoSandbox(sandbox) && sandbox.isWindows()) throw error;
    }
  }

  let result: SandboxCommandResult;
  const uploadCommand = buildPosixCurlUploadCommand(
    fullPath,
    uploadUrl,
    mediaType,
  );
  try {
    result = await sandbox.commands.run(
      `${uploadCommand}; status=$?; printf '\\n${SANDBOX_UPLOAD_STATUS_MARKER}%s\\n' "$status"; exit 0`,
      {
        ...buildSandboxCommandOptions(sandbox),
        timeoutMs: SANDBOX_UPLOAD_TIMEOUT_MS,
      } as ReturnType<typeof buildSandboxCommandOptions>,
    );
  } catch (error) {
    const commandResult = commandErrorToResult(error);
    if (commandResult) {
      result = commandResult;
    } else {
      reportFailure("command", error);
      logger.error(
        "sandbox_generated_file_upload_failed",
        error instanceof Error ? error : undefined,
        {
          event: "sandbox_generated_file_upload_failed",
          service: "chat-handler",
          ...getSandboxLogFields(sandbox),
          file_name: fileName,
          file_path: fullPath,
          media_type: mediaType,
          ...getUploadFailureDiagnostics(uploadUrl, error),
          error: errorToLog(error),
        },
      );
      throw error;
    }
  }

  result = parseUploadResult(result);

  if (result.exitCode !== 0) {
    reportFailure("command", result.stderr || result.stdout, result.exitCode);
    logger.error("sandbox_generated_file_upload_failed", undefined, {
      event: "sandbox_generated_file_upload_failed",
      service: "chat-handler",
      ...getSandboxLogFields(sandbox),
      file_name: fileName,
      file_path: fullPath,
      media_type: mediaType,
      exit_code: result.exitCode,
      ...getUploadFailureDiagnostics(uploadUrl, result.stderr || result.stdout),
      stderr: result.stderr?.slice(0, 500),
      stdout: result.stdout?.slice(0, 500),
    });
    throw formatUploadFailure(fullPath, result);
  }
}

export async function uploadSandboxFileToConvex(args: {
  sandbox: AnySandbox;
  userId: string;
  fullPath: string;
  mediaType?: string;
  name?: string;
  storageRegion?: S3StorageRegion;
  onPhase?: (phase: GeneratedFileUploadPhase) => void | Promise<void>;
  onNativeStatFailure?: (
    reason: NativeStatFailureReason,
  ) => void | Promise<void>;
  onTransferAttemptFailure?: (
    failure: GeneratedFileTransferAttemptFailure,
  ) => void | Promise<void>;
}): Promise<UploadedFileInfo> {
  const recordPhase = (phase: GeneratedFileUploadPhase) => {
    try {
      if (args.onPhase) {
        void Promise.resolve(args.onPhase(phase)).catch(() => {
          // An async observer must not create an unhandled rejection either.
        });
      }
    } catch {
      // Optional diagnostics must not affect the upload or its original error.
    }
  };
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is required for sandbox file uploads",
    );
  }

  if (!process.env.CONVEX_SERVICE_ROLE_KEY) {
    throw new Error(
      "CONVEX_SERVICE_ROLE_KEY is required for sandbox file uploads. " +
        "This is a server-only secret and must never be exposed to the client.",
    );
  }

  const { sandbox, userId, fullPath } = args;
  const mediaType = args.mediaType || DEFAULT_MEDIA_TYPE;
  recordPhase("file_metadata");
  let fileSize = await getSandboxFileSize(
    sandbox,
    fullPath,
    args.onNativeStatFailure,
  );
  // Metadata discovery also resolves legacy relays that omit their platform.
  const name = args.name || getFileNameFromPath(sandbox, fullPath);
  if (fileSize > MAX_GENERATED_FILE_SIZE_BYTES) {
    logger.warn("sandbox_generated_file_too_large", {
      event: "sandbox_generated_file_too_large",
      service: "chat-handler",
      user_id: userId,
      file_name: name,
      media_type: mediaType,
      size_bytes: fileSize,
      limit_bytes: MAX_GENERATED_FILE_SIZE_BYTES,
      ...getSandboxLogFields(sandbox),
    });
  }
  assertSandboxFileSizeAllowed(name, fileSize);
  const convex = getConvexClient();

  let uploadUrl: string;
  let s3Key: string;
  let storageLocation: S3StorageLocation;
  let refreshedSize = false;
  while (true) {
    try {
      recordPhase("upload_url");
      const generatedUrl = args.storageRegion
        ? await generateS3UploadUrl(
            name,
            mediaType,
            userId,
            fileSize,
            args.storageRegion,
          )
        : await generateS3UploadUrl(name, mediaType, userId, fileSize);
      uploadUrl = generatedUrl.uploadUrl;
      s3Key = generatedUrl.s3Key;
      storageLocation = generatedUrl.storageLocation;
    } catch (error) {
      logger.error(
        "sandbox_generated_file_upload_url_failed",
        error instanceof Error ? error : undefined,
        {
          event: "sandbox_generated_file_upload_url_failed",
          service: "chat-handler",
          user_id: userId,
          file_name: name,
          file_path: fullPath,
          media_type: mediaType,
          size_bytes: fileSize,
          ...getSandboxLogFields(sandbox),
          error: errorToLog(error),
        },
      );
      throw error;
    }

    const transferFailures: GeneratedFileTransferAttemptFailure[] = [];
    try {
      recordPhase("transfer");
      await uploadGeneratedFileFromSandboxToUrl({
        sandbox,
        fullPath,
        uploadUrl,
        mediaType,
        onFailure: (failure) => {
          transferFailures.push(failure);
          return args.onTransferAttemptFailure?.(failure);
        },
      });
      break;
    } catch (error) {
      // Content-Length is signed before the sandbox reads the file. A growing
      // report can invalidate that signature. Re-sign only a confirmed rejection
      // with a changed size; a TLS/reset failure has an unknown upload outcome.
      if (
        !refreshedSize &&
        transferFailures.length > 0 &&
        transferFailures.every(
          (failure) =>
            failure.upload_reported_http_status === 403 &&
            failure.upload_reported_storage_code === "SignatureDoesNotMatch",
        )
      ) {
        const latestSize = await getSandboxFileSize(sandbox, fullPath).catch(
          () => null,
        );
        if (latestSize !== null && latestSize !== fileSize) {
          recordPhase("file_metadata");
          if (latestSize > MAX_GENERATED_FILE_SIZE_BYTES) {
            logger.warn("sandbox_generated_file_too_large", {
              event: "sandbox_generated_file_too_large",
              service: "chat-handler",
              user_id: userId,
              file_name: name,
              media_type: mediaType,
              size_bytes: latestSize,
              limit_bytes: MAX_GENERATED_FILE_SIZE_BYTES,
              ...getSandboxLogFields(sandbox),
            });
          }
          assertSandboxFileSizeAllowed(name, latestSize);
          fileSize = latestSize;
          refreshedSize = true;
          continue;
        }
      }
      logger.error(
        "sandbox_generated_file_upload_to_url_failed",
        error instanceof Error ? error : undefined,
        {
          event: "sandbox_generated_file_upload_to_url_failed",
          service: "chat-handler",
          user_id: userId,
          file_name: name,
          file_path: fullPath,
          media_type: mediaType,
          size_bytes: fileSize,
          s3_key: s3Key,
          ...getSandboxLogFields(sandbox),
          error: errorToLog(error),
        },
      );
      throw error;
    }
  }

  try {
    recordPhase("file_registration");
    const saved = await convex.action(
      api.fileActions.saveSandboxGeneratedFile,
      {
        s3Key,
        name,
        mediaType,
        size: fileSize,
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        s3Region: storageLocation.region,
        s3Bucket: storageLocation.bucket,
      },
    );

    return {
      ...saved,
      name,
      mediaType,
      s3Key,
      sizeBytes: fileSize,
    } as UploadedFileInfo;
  } catch (error) {
    logger.error(
      "sandbox_generated_file_metadata_save_failed",
      error instanceof Error ? error : undefined,
      {
        event: "sandbox_generated_file_metadata_save_failed",
        service: "chat-handler",
        user_id: userId,
        file_name: name,
        media_type: mediaType,
        size_bytes: fileSize,
        ...getSandboxLogFields(sandbox),
        error: errorToLog(error),
      },
    );
    // Re-throw with properly extracted error message
    throw new Error(extractErrorMessage(error));
  }
}
