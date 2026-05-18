import "server-only";

import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import type { AnySandbox } from "@/types";
import { isE2BSandbox } from "./sandbox-types";
import { generateS3UploadUrl } from "@/convex/s3Utils";
import { getConvexClient } from "@/lib/db/convex-client";
import { MAX_GENERATED_FILE_SIZE_BYTES } from "@/lib/constants/s3";
import { logger } from "@/lib/logger";

const DEFAULT_MEDIA_TYPE = "application/octet-stream";
const MAX_GENERATED_FILE_SIZE_MB =
  MAX_GENERATED_FILE_SIZE_BYTES / (1024 * 1024);
const SANDBOX_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const SANDBOX_UPLOAD_STATUS_MARKER = "__HACKERAI_UPLOAD_EXIT_CODE__:";

export type UploadedFileInfo = {
  url: string;
  fileId: Id<"files">;
  tokens: number;
  // Metadata for file accumulator (avoids re-querying DB)
  name: string;
  mediaType: string;
  s3Key?: string;
  storageId?: Id<"_storage">;
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

async function getSandboxFileSize(
  sandbox: AnySandbox,
  fullPath: string,
): Promise<number> {
  const quotedPath = shellQuote(fullPath);
  const statResult = await sandbox.commands.run(
    `stat -c%s ${quotedPath} 2>/dev/null || stat -f%z ${quotedPath} 2>/dev/null`,
    { displayName: "" } as { displayName?: string },
  );

  let fileSize = parseInt(statResult.stdout.trim(), 10);
  if (!isNaN(fileSize) && statResult.exitCode === 0) {
    return fileSize;
  }

  // Windows cmd.exe fallback: %~zI expands to the file size.
  const escapedForCmd = fullPath.replace(/"/g, '\\"');
  const winResult = await sandbox.commands.run(
    `for %I in ("${escapedForCmd}") do @echo %~zI`,
    { displayName: "" } as { displayName?: string },
  );
  fileSize = parseInt(winResult.stdout.trim(), 10);
  if (!isNaN(fileSize) && winResult.exitCode === 0) {
    return fileSize;
  }

  throw new Error(
    `Failed to get file size for ${fullPath}: ${
      statResult.stderr || winResult.stderr || "stat command failed"
    }`,
  );
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

  if (!isE2BSandbox(sandbox) && sandbox.files?.uploadToUrl) {
    try {
      await sandbox.files.uploadToUrl(fullPath, uploadUrl, mediaType);
      return;
    } catch (error) {
      logger.warn("sandbox_generated_file_native_upload_failed", {
        event: "sandbox_generated_file_native_upload_failed",
        service: "chat-handler",
        sandbox_type: getSandboxLogType(sandbox),
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
        timeoutMs: SANDBOX_UPLOAD_TIMEOUT_MS,
      } as { timeoutMs?: number },
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

  const { uploadUrl, s3Key } = await generateS3UploadUrl(
    name,
    mediaType,
    userId,
  );

  await uploadGeneratedFileFromSandboxToUrl({
    sandbox,
    fullPath,
    uploadUrl,
    mediaType,
  });

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
