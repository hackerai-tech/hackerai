import {
  FileMessagePart,
  LocalDesktopFile,
  UploadedFileState,
} from "@/types/file";
import type { ChatMode } from "@/types/chat";
import {
  AGENT_MODE_MAX_FILES_LIMIT,
  getMaxFilesLimitForUploadMode,
  isSupportedImageMediaType,
  MAX_ASK_FILE_SIZE_BYTES,
  MAX_PROVIDER_IMAGE_SIZE_BYTES,
  validateUploadPolicy,
} from "./upload-policy";

export {
  AGENT_MODE_MAX_FILES_LIMIT,
  ASK_MODE_MAX_FILES_LIMIT,
  isSupportedImageMediaType,
} from "./upload-policy";

/** Rate limit info returned from upload URL generation */
export type RateLimitInfo = {
  remaining: number;
  limit: number;
  reset: number; // Unix timestamp (ms) when the limit resets
};

/** Result of upload URL generation with optional rate limit info */
export type UploadUrlResult = {
  uploadUrl: string;
  rateLimit?: RateLimitInfo;
};

/** Maximum file size allowed (10MB) */
export const MAX_FILE_SIZE = MAX_ASK_FILE_SIZE_BYTES;

/**
 * Maximum image size allowed (5MB).
 * Anthropic's Vertex/API endpoints reject base64 images over 5 MiB of raw bytes,
 * and OpenRouter re-encodes our S3 URLs as base64 before forwarding.
 */
export const MAX_IMAGE_SIZE = MAX_PROVIDER_IMAGE_SIZE_BYTES;

/** Maximum number of files allowed to be uploaded at once */
export const MAX_FILES_LIMIT = AGENT_MODE_MAX_FILES_LIMIT;

export function getMaxFilesLimitForMode(mode: ChatMode): number {
  return getMaxFilesLimitForUploadMode(mode);
}

/**
 * Check if file is an image
 */
export function isImageFile(file: File | LocalDesktopFile): boolean {
  return file.type.startsWith("image/");
}

/**
 * Validate file for upload
 */
export function validateFile(
  file: File | LocalDesktopFile,
  options: { mode?: ChatMode } = {},
): {
  valid: boolean;
  error?: string;
} {
  const validation = validateUploadPolicy({
    mode: options.mode ?? "ask",
    size: file.size,
    mediaType: file.type || "application/octet-stream",
  });
  return validation.valid
    ? { valid: true }
    : { valid: false, error: validation.message };
}

/**
 * Validate that an image file can be decoded/rendered
 * Only validates LLM-supported image formats (PNG, JPEG, WebP, GIF)
 */
export async function validateImageFile(
  file: File,
): Promise<{ valid: boolean; error?: string }> {
  if (!isSupportedImageMediaType(file.type)) {
    return { valid: true };
  }

  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      bitmap.close();
      return { valid: true };
    }

    // Fallback: Use Image API
    return new Promise((resolve) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({ valid: true });
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({
          valid: false,
          error: "Image file is corrupt or cannot be decoded",
        });
      };

      img.src = objectUrl;
    });
  } catch (error) {
    return {
      valid: false,
      error: `Image validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Create file message part from uploaded file state
 */
export function createFileMessagePartFromUploadedFile(
  uploadedFile: UploadedFileState,
): FileMessagePart | null {
  if (!uploadedFile.uploaded) {
    return null;
  }

  if (uploadedFile.storage === "local-desktop") {
    if (!uploadedFile.localAttachmentId || !uploadedFile.localPath) {
      return null;
    }

    return {
      type: "file" as const,
      mediaType: uploadedFile.file.type || "application/octet-stream",
      name: uploadedFile.file.name,
      size: uploadedFile.file.size,
      storage: "local-desktop",
      localAttachmentId: uploadedFile.localAttachmentId,
      localPath: uploadedFile.localPath,
    };
  }

  if (!uploadedFile.fileId) {
    return null;
  }

  return {
    type: "file" as const,
    mediaType: uploadedFile.file.type || "application/octet-stream",
    fileId: uploadedFile.fileId,
    name: uploadedFile.file.name,
    size: uploadedFile.file.size,
    storage: "s3",
  };
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Convert file to base64 data URL for preview
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
