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

// Maximum user attachment size for Agent mode sandbox staging (250 MB)
export const MAX_AGENT_FILE_SIZE_BYTES = 250 * 1024 * 1024;

// Maximum assistant-generated downloadable artifact size (250 MB)
export const MAX_GENERATED_FILE_SIZE_BYTES = 250 * 1024 * 1024;

// S3 key prefix for user files
export const S3_USER_FILES_PREFIX = "users";
export const MICROVM_WORKSPACE_URL_LIFETIME_SECONDS = 8 * 60 * 60;
export const MICROVM_WORKSPACE_REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
] as const;

export type MicrovmWorkspaceRegion = (typeof MICROVM_WORKSPACE_REGIONS)[number];

export const MICROVM_WORKSPACE_BUCKET_ENV_BY_REGION: Record<
  MicrovmWorkspaceRegion,
  string
> = {
  "us-east-1": "AWS_LAMBDA_MICROVM_WORKSPACE_BUCKET_US_EAST_1",
  "us-west-2": "AWS_LAMBDA_MICROVM_WORKSPACE_BUCKET_US_WEST_2",
  "eu-west-1": "AWS_LAMBDA_MICROVM_WORKSPACE_BUCKET_EU_WEST_1",
};

/**
 * One durable workspace object per user. The object is replaced only after the
 * last active Agent run finishes and is deleted with the user's cloud sandbox
 * or account.
 */
export function getMicrovmWorkspaceS3Key(userId: string): string {
  return `${S3_USER_FILES_PREFIX}/${encodeURIComponent(userId)}/microvm-workspace/v1/workspace.tar.gz`;
}
