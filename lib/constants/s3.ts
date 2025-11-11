/**
 * S3 Configuration Constants
 *
 * Centralized constants for S3 operations to ensure consistency
 * between client and server implementations.
 *
 * @module lib/constants/s3
 */

/**
 * S3 presigned URL lifetime in seconds
 * URLs will expire after this duration from generation time
 */
export const S3_URL_LIFETIME_SECONDS = 3600; // 1 hour

/**
 * Time buffer before URL expiration to trigger refresh (in seconds)
 * URLs will be refreshed when they have less than this time remaining
 */
export const S3_URL_EXPIRATION_BUFFER_SECONDS = 300; // 5 minutes

/**
 * Maximum file size allowed for uploads (in bytes)
 */
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * S3 Configuration object
 * Use this for importing multiple constants at once
 */
export const S3_CONFIG = {
  URL_LIFETIME_SECONDS: S3_URL_LIFETIME_SECONDS,
  URL_EXPIRATION_BUFFER_SECONDS: S3_URL_EXPIRATION_BUFFER_SECONDS,
  MAX_FILE_SIZE_BYTES,
} as const;
