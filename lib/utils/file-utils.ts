import { FileMessagePart, UploadedFileState } from "@/types/file";
import { Id } from "@/convex/_generated/dataModel";
import { inferMimeTypeFromFileName } from "@/convex/constants";

/**
 * Upload a single file to Convex storage and return file ID and URL
 */
export async function uploadSingleFileToConvex(
  file: File,
  generateUploadUrl: () => Promise<string>,
  saveFile: (args: {
    storageId: Id<"_storage">;
    name: string;
    mediaType: string;
    size: number;
  }) => Promise<{ url: string; fileId: string; tokens: number }>,
): Promise<{ fileId: string; url: string; tokens: number }> {
  // Step 1: Get upload URL
  const postUrl = await generateUploadUrl();

  // Step 2: Upload file to Convex storage
  const result = await fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": getContentType(file) },
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
    mediaType: getContentType(file),
    size: file.size,
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

  return {
    type: "file" as const,
    mediaType: getContentType(uploadedFile.file),
    fileId: uploadedFile.fileId,
    name: uploadedFile.file.name,
    size: uploadedFile.file.size,
    // DON'T store URL - it expires! Generate on-demand via fileId
  };
}

/**
 * Get content type with fallback to file extension inference
 * This is the defensive boundary layer for unreliable browser File API
 *
 * @param file - Browser File object
 * @returns Non-empty MIME type string (guaranteed)
 */
export function getContentType(file: File): string {
  // If browser provides MIME type, use it
  if (file.type && file.type.trim().length > 0) {
    return file.type;
  }

  // Fallback: infer from file extension
  return inferMimeTypeFromFileName(file.name);
}

/**
 * Get the maximum file size allowed (in bytes)
 */
export function getMaxFileSize(): number {
  return 10 * 1024 * 1024; // 10MB
}

/**
 * Validate file for upload
 * Checks file size (MIME type is handled by getContentType with automatic fallback)
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
  return getContentType(file).startsWith("image/");
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
 * Check if media type is a supported file format that can be directly processed by AI
 * Supports: PDF and text files (CSV, Markdown, TXT)
 */
export function isSupportedFileMediaType(mediaType: string): boolean {
  const supportedTypes = [
    "application/pdf",
    "text/csv",
    "text/markdown",
    "text/plain",
    "text/html",
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
    mediaType: getContentType(uploadedFile.file),
    fileId: uploadedFile.fileId,
    name: uploadedFile.file.name,
    size: uploadedFile.file.size,
    // DON'T store URL - it expires! Generate on-demand via fileId
    // url: uploadedFile.url,
  };
}
