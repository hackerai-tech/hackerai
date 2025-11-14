/**
 * MIME Type Mappings for File Extensions
 *
 * Shared constant used by both client and server code to ensure consistency
 * when inferring MIME types from file extensions.
 *
 * This is the single source of truth for MIME type detection.
 */

export const MIME_TYPE_MAP: Record<string, string> = {
  // Text formats
  'md': 'text/markdown',
  'markdown': 'text/markdown',
  'csv': 'text/csv',
  'txt': 'text/plain',
  'json': 'application/json',
  'xml': 'application/xml',

  // Documents
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // Images
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'bmp': 'image/bmp',
  'ico': 'image/x-icon',

  // Audio/Video
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'mp4': 'video/mp4',
  'avi': 'video/x-msvideo',

  // Archives
  'zip': 'application/zip',
  'tar': 'application/x-tar',
  'gz': 'application/gzip',
  '7z': 'application/x-7z-compressed',
};

/**
 * Default MIME type for unknown file extensions
 */
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Get MIME type for a given file extension
 *
 * @param extension - File extension (without dot)
 * @returns MIME type string
 */
export function getMimeTypeForExtension(extension: string): string {
  return MIME_TYPE_MAP[extension.toLowerCase()] || DEFAULT_MIME_TYPE;
}

/**
 * Infer MIME type from filename
 *
 * @param fileName - Complete filename (e.g., "document.pdf")
 * @returns MIME type string
 */
export function inferMimeTypeFromFileName(fileName: string): string {
  const extension = fileName.toLowerCase().split('.').pop() || '';
  return getMimeTypeForExtension(extension);
}
