/**
 * S3 Configuration Constants
 *
 * Centralized constants for S3 file storage configuration.
 */

export const S3_STORAGE_REGIONS = [
  "eu-central-1",
  "us-east-1",
  "us-west-2",
] as const;

export type S3StorageRegion = (typeof S3_STORAGE_REGIONS)[number];

export type S3StorageLocation = {
  region: string;
  bucket: string;
};

export const S3_REGIONAL_BUCKET_ENV_NAMES: Record<
  S3StorageRegion,
  | "AWS_S3_BUCKET_NAME_EU_CENTRAL_1"
  | "AWS_S3_BUCKET_NAME_US_EAST_1"
  | "AWS_S3_BUCKET_NAME_US_WEST_2"
> = {
  "eu-central-1": "AWS_S3_BUCKET_NAME_EU_CENTRAL_1",
  "us-east-1": "AWS_S3_BUCKET_NAME_US_EAST_1",
  "us-west-2": "AWS_S3_BUCKET_NAME_US_WEST_2",
};

export const isS3StorageRegion = (
  value: string | null | undefined,
): value is S3StorageRegion =>
  S3_STORAGE_REGIONS.includes(value as S3StorageRegion);

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

// Maximum user attachment size for Agent mode sandbox staging (250 MB)
export const MAX_AGENT_FILE_SIZE_BYTES = 250 * 1024 * 1024;

// Maximum assistant-generated downloadable artifact size (250 MB)
export const MAX_GENERATED_FILE_SIZE_BYTES = 250 * 1024 * 1024;

// S3 key prefix for user files
export const S3_USER_FILES_PREFIX = "users";
