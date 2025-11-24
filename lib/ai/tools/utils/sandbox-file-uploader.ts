import "server-only";

import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import type { AnySandbox } from "@/types";
import { isE2BSandbox } from "./sandbox-types";
import { generateS3UploadUrl } from "@/convex/s3Utils";

const DEFAULT_MEDIA_TYPE = "application/octet-stream";
const USE_S3_STORAGE = process.env.NEXT_PUBLIC_USE_S3_STORAGE === "true";

export type UploadedFileInfo = {
  url: string;
  fileId: Id<"files">;
  tokens: number;
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

  let blob: Blob;

  if (isE2BSandbox(sandbox)) {
    // E2B Sandbox: use downloadUrl
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
    // ConvexSandbox: use files.read
    const content = await sandbox.files.read(fullPath);
    blob = new Blob([content], { type: DEFAULT_MEDIA_TYPE });
  }
  const mediaType = DEFAULT_MEDIA_TYPE;
  const name = fullPath.split("/").pop() || "file";

  if (USE_S3_STORAGE) {
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

      return saved as UploadedFileInfo;
    } catch (error) {
      // Re-throw with properly extracted error message
      throw new Error(extractErrorMessage(error));
    }
  } else {
    // Convex upload path (existing)
    const postUrl = await convex.mutation(api.fileStorage.generateUploadUrl, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
    });

    const uploadRes = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": mediaType },
      body: blob,
    });

    if (!uploadRes.ok) {
      throw new Error(
        `Upload failed for ${fullPath}: ${uploadRes.status} ${uploadRes.statusText}`,
      );
    }

    const { storageId } = (await uploadRes.json()) as { storageId: string };

    try {
      const saved = await convex.action(api.fileActions.saveFile, {
        storageId: storageId as Id<"_storage">,
        name,
        mediaType,
        size: blob.size,
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        skipTokenValidation: args.skipTokenValidation,
      });

      return saved as UploadedFileInfo;
    } catch (error) {
      // Re-throw with properly extracted error message
      throw new Error(extractErrorMessage(error));
    }
  }
}

/**
 * Upload base64-encoded binary data directly to storage without saving to sandbox
 */
export async function uploadBase64ToConvex(args: {
  base64Data: string;
  userId: string;
  fileName: string;
  mediaType: string;
  skipTokenValidation?: boolean;
}): Promise<UploadedFileInfo> {
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required for file uploads");
  }

  if (!process.env.CONVEX_SERVICE_ROLE_KEY) {
    throw new Error(
      "CONVEX_SERVICE_ROLE_KEY is required for file uploads. " +
        "This is a server-only secret and must never be exposed to the client.",
    );
  }

  const { base64Data, userId, fileName, mediaType } = args;
  const convex = getConvexClient();

  // Convert base64 to blob
  const binaryString = Buffer.from(base64Data, "base64");
  const blob = new Blob([binaryString], { type: mediaType });

  if (USE_S3_STORAGE) {
    // S3 upload path
    const { uploadUrl, s3Key } = await generateS3UploadUrl(
      fileName,
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
        `S3 upload failed for ${fileName}: ${uploadRes.status} ${uploadRes.statusText}`,
      );
    }

    try {
      const saved = await convex.action(api.fileActions.saveFile, {
        s3Key,
        name: fileName,
        mediaType,
        size: blob.size,
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        skipTokenValidation: args.skipTokenValidation,
      });

      return saved as UploadedFileInfo;
    } catch (error) {
      // Re-throw with properly extracted error message
      throw new Error(extractErrorMessage(error));
    }
  } else {
    // Convex upload path (existing)
    const postUrl = await convex.mutation(api.fileStorage.generateUploadUrl, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
    });

    const uploadRes = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": mediaType },
      body: blob,
    });

    if (!uploadRes.ok) {
      throw new Error(
        `Upload failed for ${fileName}: ${uploadRes.status} ${uploadRes.statusText}`,
      );
    }

    const { storageId } = (await uploadRes.json()) as { storageId: string };

    try {
      const saved = await convex.action(api.fileActions.saveFile, {
        storageId: storageId as Id<"_storage">,
        name: fileName,
        mediaType,
        size: blob.size,
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        skipTokenValidation: args.skipTokenValidation,
      });

      return saved as UploadedFileInfo;
    } catch (error) {
      // Re-throw with properly extracted error message
      throw new Error(extractErrorMessage(error));
    }
  }
}
