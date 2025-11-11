/**
 * File Validation Utilities
 *
 * Provides security-focused file validation including:
 * - MIME type validation
 * - File signature (magic number) verification
 * - Content-Type vs actual file content validation
 * - File size validation
 *
 * @module convex/fileValidation
 */

"use node";

import { MAX_FILE_SIZE_BYTES } from "../lib/constants/s3";

// =============================================================================
// FILE SIGNATURES (Magic Numbers)
// =============================================================================

/**
 * Known file signatures for common file types
 * Used to verify actual file content matches declared Content-Type
 */
const FILE_SIGNATURES: Record<string, Array<{pattern: number[]; offset: number}>> = {
  // Images
  "image/png": [{ pattern: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 }],
  "image/jpeg": [
    { pattern: [0xff, 0xd8, 0xff], offset: 0 },
  ],
  "image/gif": [
    { pattern: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], offset: 0 }, // GIF87a
    { pattern: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], offset: 0 }, // GIF89a
  ],
  "image/webp": [{ pattern: [0x52, 0x49, 0x46, 0x46], offset: 0 }], // RIFF...WEBP

  // Documents
  "application/pdf": [{ pattern: [0x25, 0x50, 0x44, 0x46], offset: 0 }], // %PDF
  "application/zip": [
    { pattern: [0x50, 0x4b, 0x03, 0x04], offset: 0 }, // PK..
    { pattern: [0x50, 0x4b, 0x05, 0x06], offset: 0 }, // PK.. (empty archive)
  ],
  // DOCX, XLSX, etc. are ZIP files
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    { pattern: [0x50, 0x4b, 0x03, 0x04], offset: 0 },
  ],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    { pattern: [0x50, 0x4b, 0x03, 0x04], offset: 0 },
  ],
};

/**
 * Allowed MIME types for upload
 * Whitelist approach for security
 */
const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",

  // Documents
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/csv",
  "text/markdown",
  "application/json",

  // Office documents
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // DOCX
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // XLSX
  "application/msword", // DOC
  "application/vnd.ms-excel", // XLS

  // Archives
  "application/zip",
  "application/x-zip-compressed",

  // Code files
  "text/javascript",
  "application/javascript",
  "text/x-python",
  "text/x-java",
  "text/x-c",
  "text/x-c++",
  "text/x-sh",
  "application/x-sh",

  // Other text
  "text/html",
  "text/xml",
  "application/xml",

  // Binary/Unknown (default for files with unknown MIME type)
  "application/octet-stream",
]);

// =============================================================================
// VALIDATION FUNCTIONS
// =============================================================================

/**
 * Check if file signature matches expected pattern
 */
function matchesSignature(
  buffer: Buffer,
  signature: { pattern: number[]; offset: number },
): boolean {
  const { pattern, offset } = signature;

  if (buffer.length < offset + pattern.length) {
    return false;
  }

  for (let i = 0; i < pattern.length; i++) {
    if (buffer[offset + i] !== pattern[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Verify file content matches declared MIME type using file signatures
 *
 * @param buffer - File content buffer (first few KB is sufficient)
 * @param declaredMimeType - MIME type from Content-Type header
 * @returns true if file signature matches, false otherwise
 */
export function verifyFileSignature(
  buffer: Buffer,
  declaredMimeType: string,
): boolean {
  // Normalize MIME type
  const mimeType = declaredMimeType.toLowerCase().split(";")[0].trim();

  // Text files don't have signatures - allow them
  if (mimeType.startsWith("text/")) {
    return true;
  }

  // JSON, CSV also don't have signatures
  if (
    mimeType === "application/json" ||
    mimeType === "application/csv" ||
    mimeType === "text/csv"
  ) {
    return true;
  }

  // If we have a signature for this type, verify it
  const signatures = FILE_SIGNATURES[mimeType];
  if (signatures) {
    return signatures.some((sig) => matchesSignature(buffer, sig));
  }

  // For unknown types, we can't verify - return true to allow
  // (Whitelist in ALLOWED_MIME_TYPES provides security)
  return true;
}

/**
 * Check if MIME type is allowed for upload
 *
 * @param mimeType - MIME type to check
 * @returns true if allowed, false otherwise
 */
export function isAllowedMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(";")[0].trim();

  // Handle empty/unknown MIME types - default to application/octet-stream
  // This commonly happens with files that browsers don't recognize (e.g., .md, .log, etc.)
  if (normalized.length === 0) {
    return ALLOWED_MIME_TYPES.has("application/octet-stream");
  }

  return ALLOWED_MIME_TYPES.has(normalized);
}

/**
 * Validate file size
 *
 * @param size - File size in bytes
 * @param maxSizeBytes - Maximum allowed size (default: 20MB from S3_CONFIG)
 * @returns Error message if invalid, null if valid
 */
export function validateFileSize(
  size: number,
  maxSizeBytes: number = MAX_FILE_SIZE_BYTES,
): string | null {
  if (size <= 0) {
    return "File size must be greater than 0";
  }

  if (size > maxSizeBytes) {
    const sizeMB = (size / (1024 * 1024)).toFixed(2);
    const maxSizeMB = (maxSizeBytes / (1024 * 1024)).toFixed(0);
    return `File size (${sizeMB}MB) exceeds maximum allowed size of ${maxSizeMB}MB`;
  }

  return null;
}

/**
 * Validate file name
 *
 * @param fileName - File name to validate
 * @returns Error message if invalid, null if valid
 */
export function validateFileName(fileName: string): string | null {
  if (!fileName || typeof fileName !== "string") {
    return "File name is required";
  }

  if (fileName.trim().length === 0) {
    return "File name cannot be empty";
  }

  if (fileName.length > 255) {
    return "File name is too long (max 255 characters)";
  }

  // Check for path traversal attempts
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return "File name contains invalid characters";
  }

  return null;
}

/**
 * Comprehensive file validation
 *
 * @param fileName - Original file name
 * @param mimeType - Declared MIME type
 * @param size - File size in bytes
 * @param buffer - File content buffer (optional, for signature verification)
 * @returns Object with isValid boolean and error message if invalid
 */
export interface FileValidationResult {
  isValid: boolean;
  error?: string;
}

export function validateFile(
  fileName: string,
  mimeType: string,
  size: number,
  buffer?: Buffer,
): FileValidationResult {
  // Validate file name
  const nameError = validateFileName(fileName);
  if (nameError) {
    return { isValid: false, error: nameError };
  }

  // Validate MIME type
  if (!isAllowedMimeType(mimeType)) {
    return {
      isValid: false,
      error: `File type "${mimeType}" is not allowed. Please upload a supported file type.`,
    };
  }

  // Validate size
  const sizeError = validateFileSize(size);
  if (sizeError) {
    return { isValid: false, error: sizeError };
  }

  // Verify file signature if buffer provided
  if (buffer && buffer.length > 0) {
    if (!verifyFileSignature(buffer, mimeType)) {
      return {
        isValid: false,
        error: `File content does not match declared type "${mimeType}". Possible file type spoofing detected.`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Get user-friendly file type name
 */
export function getFileTypeName(mimeType: string): string {
  const typeMap: Record<string, string> = {
    "image/png": "PNG Image",
    "image/jpeg": "JPEG Image",
    "image/jpg": "JPEG Image",
    "image/gif": "GIF Image",
    "image/webp": "WebP Image",
    "application/pdf": "PDF Document",
    "text/plain": "Text File",
    "text/csv": "CSV File",
    "application/json": "JSON File",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word Document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel Spreadsheet",
  };

  return typeMap[mimeType] || mimeType;
}
