import "server-only";

import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import type { AnySandbox } from "@/types";
import { isCentrifugoSandbox, isE2BSandbox } from "./sandbox-types";
import { buildSandboxCommandOptions } from "./sandbox-command-options";
import { generateS3UploadUrl } from "@/convex/s3Utils";
import { getConvexClient } from "@/lib/db/convex-client";
import { MAX_GENERATED_FILE_SIZE_BYTES } from "@/lib/constants/s3";
import { logger } from "@/lib/logger";

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
};

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

function shouldTryWindowsFileSizeFallback(sandbox: AnySandbox): boolean {
  return isCentrifugoSandbox(sandbox) && sandbox.isWindows();
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
  winResult?: SandboxCommandResult,
): Error {
  const details = [
    statResult.stderr,
    statResult.stdout,
    winResult?.stderr,
    winResult?.stdout,
  ]
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
): Promise<number> {
  const quotedPath = shellQuote(fullPath);
  const commandOptions = buildSandboxCommandOptions(sandbox);
  let statResult: SandboxCommandResult;
  try {
    statResult = await sandbox.commands.run(
      `if [ ! -e ${quotedPath} ] && [ ! -L ${quotedPath} ]; then printf 'File not found: %s\\n' ${quotedPath} >&2; exit 66; fi; stat -c%s ${quotedPath} 2>/dev/null || stat -f%z ${quotedPath}`,
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
          sandbox_type: getSandboxLogType(sandbox),
          file_name: getFileNameFromPath(fullPath),
          file_path: fullPath,
          error: errorToLog(error),
        },
      );
      throw error;
    }
    statResult = commandResult;
  }

  let fileSize = parseInt(statResult.stdout.trim(), 10);
  if (!isNaN(fileSize) && statResult.exitCode === 0) {
    return fileSize;
  }

  if (!shouldTryWindowsFileSizeFallback(sandbox)) {
    logger.error("sandbox_generated_file_size_failed", undefined, {
      event: "sandbox_generated_file_size_failed",
      service: "chat-handler",
      sandbox_type: getSandboxLogType(sandbox),
      file_name: getFileNameFromPath(fullPath),
      file_path: fullPath,
      stat_exit_code: statResult.exitCode,
      stat_stderr: statResult.stderr?.slice(0, 500),
      stat_stdout: statResult.stdout?.slice(0, 500),
    });
    throw formatFileSizeFailure(fullPath, statResult);
  }

  assertWindowsFileSizeFallbackPathSafe(fullPath);

  // Windows cmd.exe fallback: delayed expansion avoids reparsing path
  // metacharacters such as & after the command has been parsed.
  const winCommand = `setlocal EnableDelayedExpansion && for %I in ("!${WINDOWS_FILE_SIZE_PATH_ENV_VAR}!") do @echo %~zI`;
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
          sandbox_type: getSandboxLogType(sandbox),
          file_name: getFileNameFromPath(fullPath),
          file_path: fullPath,
          stat_exit_code: statResult.exitCode,
          stat_stderr: statResult.stderr?.slice(0, 500),
          stat_stdout: statResult.stdout?.slice(0, 500),
          error: errorToLog(error),
        },
      );
      throw error;
    }
    winResult = commandResult;
  }
  fileSize = parseInt(winResult.stdout.trim(), 10);
  if (!isNaN(fileSize) && winResult.exitCode === 0) {
    return fileSize;
  }

  logger.error("sandbox_generated_file_size_failed", undefined, {
    event: "sandbox_generated_file_size_failed",
    service: "chat-handler",
    sandbox_type: getSandboxLogType(sandbox),
    file_name: getFileNameFromPath(fullPath),
    file_path: fullPath,
    stat_exit_code: statResult.exitCode,
    stat_stderr: statResult.stderr?.slice(0, 500),
    stat_stdout: statResult.stdout?.slice(0, 500),
    windows_exit_code: winResult.exitCode,
    windows_stderr: winResult.stderr?.slice(0, 500),
    windows_stdout: winResult.stdout?.slice(0, 500),
  });
  throw formatFileSizeFailure(fullPath, statResult, winResult);
}

function assertSandboxFileSizeAllowed(fileName: string, size: number): void {
  if (size <= MAX_GENERATED_FILE_SIZE_BYTES) return;

  throw new Error(
    `File "${fileName}" exceeds the maximum generated file size limit of ${MAX_GENERATED_FILE_SIZE_MB} MB. Current size: ${(size / (1024 * 1024)).toFixed(2)} MB`,
  );
}

function getSandboxLogType(sandbox: AnySandbox): "e2b" | "centrifugo" {
  return isE2BSandbox(sandbox) ? "e2b" : "centrifugo";
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

function getFileNameFromPath(fullPath: string): string {
  return fullPath.split(/[/\\]/).pop() || "file";
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
}): Promise<void> {
  const { sandbox, fullPath, uploadUrl, mediaType } = args;
  const fileName = getFileNameFromPath(fullPath);

  if (!isE2BSandbox(sandbox) && sandbox.files?.uploadToUrl) {
    try {
      await sandbox.files.uploadToUrl(fullPath, uploadUrl, mediaType);
      return;
    } catch (error) {
      logger.warn("sandbox_generated_file_native_upload_failed", {
        event: "sandbox_generated_file_native_upload_failed",
        service: "chat-handler",
        sandbox_type: getSandboxLogType(sandbox),
        file_name: fileName,
        file_path: fullPath,
        media_type: mediaType,
        error: errorToLog(error),
      });
    }
  }

  let result: SandboxCommandResult;
  const uploadCommand = `curl -fsSL -X PUT -H ${shellQuote(`Content-Type: ${mediaType}`)} --data-binary @${shellQuote(fullPath)} ${shellQuote(uploadUrl)}`;
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
      logger.error(
        "sandbox_generated_file_upload_failed",
        error instanceof Error ? error : undefined,
        {
          event: "sandbox_generated_file_upload_failed",
          service: "chat-handler",
          sandbox_type: getSandboxLogType(sandbox),
          file_name: fileName,
          file_path: fullPath,
          media_type: mediaType,
          error: errorToLog(error),
        },
      );
      throw error;
    }
  }

  result = parseUploadResult(result);

  if (result.exitCode !== 0) {
    logger.error("sandbox_generated_file_upload_failed", undefined, {
      event: "sandbox_generated_file_upload_failed",
      service: "chat-handler",
      sandbox_type: getSandboxLogType(sandbox),
      file_name: fileName,
      file_path: fullPath,
      media_type: mediaType,
      exit_code: result.exitCode,
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
}): Promise<UploadedFileInfo> {
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
  const name = args.name || getFileNameFromPath(fullPath);
  const fileSize = await getSandboxFileSize(sandbox, fullPath);
  if (fileSize > MAX_GENERATED_FILE_SIZE_BYTES) {
    logger.warn("sandbox_generated_file_too_large", {
      event: "sandbox_generated_file_too_large",
      service: "chat-handler",
      user_id: userId,
      file_name: name,
      media_type: mediaType,
      size_bytes: fileSize,
      limit_bytes: MAX_GENERATED_FILE_SIZE_BYTES,
      sandbox_type: getSandboxLogType(sandbox),
    });
  }
  assertSandboxFileSizeAllowed(name, fileSize);
  const convex = getConvexClient();

  let uploadUrl: string;
  let s3Key: string;
  try {
    const generatedUrl = await generateS3UploadUrl(
      name,
      mediaType,
      userId,
      fileSize,
    );
    uploadUrl = generatedUrl.uploadUrl;
    s3Key = generatedUrl.s3Key;
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
        sandbox_type: getSandboxLogType(sandbox),
        error: errorToLog(error),
      },
    );
    throw error;
  }

  try {
    await uploadGeneratedFileFromSandboxToUrl({
      sandbox,
      fullPath,
      uploadUrl,
      mediaType,
    });
  } catch (error) {
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
        sandbox_type: getSandboxLogType(sandbox),
        error: errorToLog(error),
      },
    );
    throw error;
  }

  try {
    const saved = await convex.action(
      api.fileActions.saveSandboxGeneratedFile,
      {
        s3Key,
        name,
        mediaType,
        size: fileSize,
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
      },
    );

    return {
      ...saved,
      name,
      mediaType,
      s3Key,
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
        sandbox_type: getSandboxLogType(sandbox),
        error: errorToLog(error),
      },
    );
    // Re-throw with properly extracted error message
    throw new Error(extractErrorMessage(error));
  }
}
