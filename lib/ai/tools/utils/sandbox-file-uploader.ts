import "server-only";

import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import type { AnySandbox } from "@/types";
import { isE2BSandbox } from "./sandbox-types";
import { generateS3UploadUrl } from "@/convex/s3Utils";

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

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

let convexClient: ConvexHttpClient | null = null;
function getConvexClient(): ConvexHttpClient {
  if (!convexClient) {
    convexClient = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  }
  return convexClient;
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

export async function uploadSandboxFileToConvex(args: {
  sandbox: AnySandbox;
  userId: string;
  fullPath: string;
  skipTokenValidation?: boolean;
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
  const convex = getConvexClient();

  const mediaType = DEFAULT_MEDIA_TYPE;
  const name = fullPath.split("/").pop() || "file";

  // For ConvexSandbox, always upload directly from sandbox to S3
  // This avoids data corruption and size limits when piping through Convex commands
  if (!isE2BSandbox(sandbox) && sandbox.files?.uploadToUrl) {
    const { uploadUrl, s3Key } = await generateS3UploadUrl(
      name,
      mediaType,
      userId,
    );

    // Upload directly from sandbox to S3
    await sandbox.files.uploadToUrl(fullPath, uploadUrl, mediaType);

    // Get file size via stat command (try Linux format first, then macOS)
    const statResult = await sandbox.commands.run(
      `stat -c%s "${fullPath}" 2>/dev/null || stat -f%z "${fullPath}"`,
      // Hide from local CLI output (internal operation)
      { displayName: "" } as { displayName?: string },
    );
    const fileSize = parseInt(statResult.stdout.trim(), 10);
    if (isNaN(fileSize) || statResult.exitCode !== 0) {
      throw new Error(
        `Failed to get file size for ${fullPath}: ${statResult.stderr || "stat command failed"}`,
      );
    }

    try {
      const saved = await convex.action(api.fileActions.saveFile, {
        s3Key,
        name,
        mediaType,
        size: fileSize,
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        skipTokenValidation: args.skipTokenValidation,
      });

      return {
        ...saved,
        name,
        mediaType,
        s3Key,
      } as UploadedFileInfo;
    } catch (error) {
      throw new Error(extractErrorMessage(error));
    }
  }

  // E2B Sandbox: use downloadUrl to fetch file, then upload to storage
  let blob: Blob;

  if (isE2BSandbox(sandbox)) {
    const downloadUrl = await sandbox.downloadUrl(fullPath, {
      useSignatureExpiration: 30_000, // 30 seconds
    });

    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) {
      throw new Error(
        `Failed to download ${fullPath}: ${fileRes.status} ${fileRes.statusText}`,
      );
    }

    blob = await fileRes.blob();
  } else {
    // Fallback for unknown sandbox types
    throw new Error("Unsupported sandbox type for file upload");
  }

  // S3 upload path
  const { uploadUrl, s3Key } = await generateS3UploadUrl(
    name,
    mediaType,
    userId,
  );

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": mediaType },
    body: blob,
  });

  if (!uploadRes.ok) {
    throw new Error(
      `S3 upload failed for ${fullPath}: ${uploadRes.status} ${uploadRes.statusText}`,
    );
  }

  try {
    const saved = await convex.action(api.fileActions.saveFile, {
      s3Key,
      name,
      mediaType,
      size: blob.size,
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
      skipTokenValidation: args.skipTokenValidation,
    });

    return {
      ...saved,
      name,
      mediaType,
      s3Key,
    } as UploadedFileInfo;
  } catch (error) {
    // Re-throw with properly extracted error message
    throw new Error(extractErrorMessage(error));
  }
}
