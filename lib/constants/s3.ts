/**
 * S3 Configuration Constants
 *
 * Centralized constants for S3 file storage configuration.
 */

// S3 presigned URL lifetime (defaults to 1 hour if not set)
// Use function to read at runtime, not at module load time (avoids Convex caching)
export const getS3UrlLifetimeSeconds = (): number => {
  return parseInt(process.env.S3_URL_LIFETIME_SECONDS || "3600", 10);
};

// Buffer time before URL expiration for refresh (defaults to 5 minutes if not set)
// Use function to read at runtime, not at module load time (avoids Convex caching)
export const getS3UrlExpirationBufferSeconds = (): number => {
  return parseInt(process.env.S3_URL_EXPIRATION_BUFFER_SECONDS || "300", 10);
};

// Maximum file size (20 MB)
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

// S3 key prefix for user files
export const S3_USER_FILES_PREFIX = "users";
