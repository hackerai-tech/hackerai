/**
 * S3 Configuration Constants
 *
 * Centralized constants for S3 file storage configuration.
 */

// S3 presigned URL lifetime (1 hour)
export const S3_URL_LIFETIME_SECONDS = 3600;

// Buffer time before URL expiration for refresh (5 minutes)
export const S3_URL_EXPIRATION_BUFFER_SECONDS = 300;

// Maximum file size (20 MB)
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

// S3 key prefix for user files
export const S3_USER_FILES_PREFIX = "users";
