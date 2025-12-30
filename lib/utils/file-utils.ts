import { FileMessagePart, UploadedFileState } from "@/types/file";
import { Id } from "@/convex/_generated/dataModel";

/**
 * Upload a single file to Convex storage and return file ID and URL
 */
export async function uploadSingleFileToConvex(
  file: File,
  generateUploadUrl: () => Promise<string>,
  saveFile: (
    args: any,
  ) => Promise<{ url: string; fileId: string; tokens: number }>,
  mode: "ask" | "agent" = "ask",
): Promise<{ fileId: string; url: string; tokens: number }> {
  // Step 1: Get upload URL
  const postUrl = await generateUploadUrl();

  // Step 2: Upload file to Convex storage
  // Use a fallback Content-Type if browser doesn't provide one (common for .md, .txt files)
  const contentType = file.type || "application/octet-stream";
  const result = await fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: file,
  });

  if (!result.ok) {
    throw new Error(`Failed to upload file ${file.name}: ${result.statusText}`);
  }

  const { storageId } = await result.json();

  // Step 3: Save file metadata to database and get URL, file ID, and tokens
  const { url, fileId, tokens } = await saveFile({
    storageId,
    name: file.name,
    mediaType: contentType,
    size: file.size,
    mode,
  });

  return { fileId, url, tokens };
}

/**
 * Create file message part from uploaded file state (includes fileId only)
 * URLs are generated on-demand to avoid expiration issues
 */
export function createFileMessagePart(
  uploadedFile: UploadedFileState,
): FileMessagePart {
  if (!uploadedFile.fileId) {
    throw new Error("File must have fileId to create message part");
  }

  // Use fallback for empty media types (common for .md, .txt files)
  const mediaType = uploadedFile.file.type || "application/octet-stream";

  return {
    type: "file" as const,
    mediaType,
    fileId: uploadedFile.fileId,
    name: uploadedFile.file.name,
    size: uploadedFile.file.size,
    // DON'T store URL - it expires! Generate on-demand via fileId
  };
}

/**
 * Get the maximum file size allowed (in bytes)
 */
export function getMaxFileSize(): number {
  return 10 * 1024 * 1024; // 10MB
}

/**
 * Validate that an image file can be decoded/rendered
 * Uses createImageBitmap for reliable validation
 * Only validates LLM-supported image formats (PNG, JPEG, WebP, GIF)
 * @param file - The image file to validate
 * @returns Promise with validation result
 */
export async function validateImageFile(file: File): Promise<{
  valid: boolean;
  error?: string;
}> {
  // Only validate LLM-supported image formats
  // Other image types (SVG, BMP, etc.) are skipped as they're not processed by AI
  if (!isSupportedImageMediaType(file.type)) {
    return { valid: true };
  }

  try {
    // Use createImageBitmap for validation (works in browser)
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
 * Validate file for upload
 */
export function validateFile(file: File): { valid: boolean; error?: string } {
  if (file.size > getMaxFileSize()) {
    return {
      valid: false,
      error: `File size must be less than ${getMaxFileSize() / (1024 * 1024)}MB`,
    };
  }

  return { valid: true };
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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

/**
 * Check if file is an image that can be previewed
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Check if media type is a supported image format for AI
 * AI supports: PNG, JPEG, WEBP, and non-animated GIF
 */
export function isSupportedImageMediaType(mediaType: string): boolean {
  const supportedTypes = [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
  ];
  return supportedTypes.includes(mediaType.toLowerCase());
}

/**
 * Maximum number of files allowed to be uploaded at once
 */
export const MAX_FILES_LIMIT = 5;

/**
 * Helper to create file message part from uploadedFile that has both fileId and URL
 */
export function createFileMessagePartFromUploadedFile(
  uploadedFile: UploadedFileState,
): FileMessagePart | null {
  if (!uploadedFile.fileId || !uploadedFile.uploaded) {
    return null;
  }

  return {
    type: "file" as const,
    mediaType: uploadedFile.file.type,
    fileId: uploadedFile.fileId,
    name: uploadedFile.file.name,
    size: uploadedFile.file.size,
    // DON'T store URL - it expires! Generate on-demand via fileId
    // url: uploadedFile.url,
  };
}
