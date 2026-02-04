import { FileMessagePart, UploadedFileState } from "@/types/file";

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
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum number of files allowed to be uploaded at once */
export const MAX_FILES_LIMIT = 5;

/** Supported image formats for AI processing */
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

/**
 * Check if media type is a supported image format for AI
 */
export function isSupportedImageMediaType(mediaType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(mediaType.toLowerCase());
}

/**
 * Check if file is an image
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Validate file for upload
 */
export function validateFile(file: File): { valid: boolean; error?: string } {
  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File size must be less than ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
    };
  }
  return { valid: true };
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
  if (!uploadedFile.fileId || !uploadedFile.uploaded) {
    return null;
  }

  return {
    type: "file" as const,
    mediaType: uploadedFile.file.type || "application/octet-stream",
    fileId: uploadedFile.fileId,
    name: uploadedFile.file.name,
    size: uploadedFile.file.size,
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
