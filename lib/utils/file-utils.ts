import { FileMessagePart, FileUIObject, UploadedFileState } from "@/types/file";

/**
 * File upload utilities for handling Convex file storage
 */

/**
 * Upload files to Convex storage and return file message parts
 * Note: This function requires URLs to be fetched separately after upload
 * The getFileUrls function should be called imperatively using convex.query()
 */
export async function uploadFilesToConvex(
  files: FileList,
  generateUploadUrl: () => Promise<string>,
  getFileUrls: (storageIds: string[]) => Promise<(string | null)[]>,
): Promise<FileMessagePart[]> {
  const uploadPromises = Array.from(files).map(async (file) => {
    // Step 1: Get upload URL
    const postUrl = await generateUploadUrl();

    // Step 2: Upload file to Convex storage
    const result = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });

    if (!result.ok) {
      throw new Error(
        `Failed to upload file ${file.name}: ${result.statusText}`,
      );
    }

    const { storageId } = await result.json();

    return {
      storageId,
      file,
    };
  });

  const uploadResults = await Promise.all(uploadPromises);
  const storageIds = uploadResults.map((result) => result.storageId);

  // Fetch URLs for all uploaded files
  const urls = await getFileUrls(storageIds);

  // Create file message parts with URLs
  return uploadResults.map((result, index) => ({
    type: "file" as const,
    mediaType: result.file.type,
    storageId: result.storageId,
    name: result.file.name,
    size: result.file.size,
    url: urls[index] || "", // Fallback to empty string if URL fetch failed
  }));
}

/**
 * Upload a single file to Convex storage and return storage ID
 */
export async function uploadSingleFileToConvex(
  file: File,
  generateUploadUrl: () => Promise<string>,
): Promise<string> {
  // Step 1: Get upload URL
  const postUrl = await generateUploadUrl();

  // Step 2: Upload file to Convex storage
  const result = await fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });

  if (!result.ok) {
    throw new Error(`Failed to upload file ${file.name}: ${result.statusText}`);
  }

  const { storageId } = await result.json();
  return storageId;
}

/**
 * Create file message part from uploaded file state (includes both storageId and URL)
 */
export function createFileMessagePart(
  uploadedFile: UploadedFileState,
): FileMessagePart {
  if (!uploadedFile.storageId || !uploadedFile.url) {
    throw new Error(
      "File must have both storageId and url to create message part",
    );
  }

  return {
    type: "file" as const,
    mediaType: uploadedFile.file.type,
    storageId: uploadedFile.storageId,
    name: uploadedFile.file.name,
    size: uploadedFile.file.size,
    url: uploadedFile.url,
  };
}

/**
 * Get the maximum file size allowed (in bytes)
 */
export function getMaxFileSize(): number {
  return 10 * 1024 * 1024; // 10MB
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
 * Maximum number of files allowed to be uploaded at once
 */
export const MAX_FILES_LIMIT = 5;

/**
 * Helper to create file message part from uploadedFile that has both storageId and URL
 */
export function createFileMessagePartFromUploadedFile(
  uploadedFile: UploadedFileState,
): FileMessagePart | null {
  if (!uploadedFile.storageId || !uploadedFile.url || !uploadedFile.uploaded) {
    return null;
  }

  return {
    type: "file" as const,
    mediaType: uploadedFile.file.type,
    storageId: uploadedFile.storageId,
    name: uploadedFile.file.name,
    size: uploadedFile.file.size,
    url: uploadedFile.url,
  };
}
