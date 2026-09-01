import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import {
  getS3UrlLifetimeSeconds,
  S3_REGIONAL_BUCKET_ENV_NAMES,
  S3_USER_FILES_PREFIX,
  type S3StorageLocation,
  type S3StorageRegion,
} from "../lib/constants/s3";

/**
 * Get environment variable with validation
 */
function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Get S3 client with credentials from environment variables
 */
function getLegacyS3StorageLocation(): S3StorageLocation {
  const region = getRequiredEnvVar("AWS_S3_REGION");
  return {
    region,
    bucket: getRequiredEnvVar("AWS_S3_BUCKET_NAME"),
  };
}

function isRegionalS3StorageEnabled(): boolean {
  return process.env.S3_REGIONAL_STORAGE_ENABLED === "true";
}

/** Resolve the exact bucket used for a new upload. */
export function resolveS3UploadLocation(
  requestedRegion?: S3StorageRegion,
): S3StorageLocation {
  const legacyLocation = getLegacyS3StorageLocation();
  if (!requestedRegion || !isRegionalS3StorageEnabled()) {
    return legacyLocation;
  }

  const bucketEnvName = S3_REGIONAL_BUCKET_ENV_NAMES[requestedRegion];
  const bucket = process.env[bucketEnvName]?.trim();
  if (bucket) {
    return { region: requestedRegion, bucket };
  }

  if (legacyLocation.region === requestedRegion) {
    return legacyLocation;
  }

  throw new Error(
    `Missing required environment variable for ${requestedRegion}: ${bucketEnvName}`,
  );
}

/**
 * Convert optional database fields into a storage locator. Historical rows
 * have neither field and intentionally fall back to the legacy bucket.
 */
export function getStoredS3Location(
  region?: string,
  bucket?: string,
): S3StorageLocation | undefined {
  if (region === undefined && bucket === undefined) return undefined;
  if (region === undefined || !bucket?.trim()) {
    throw new Error("Incomplete S3 storage location metadata");
  }
  return { region, bucket: bucket.trim() };
}

/** Create an S3 client with optional path-style object addressing. */
export function getS3Client(
  location?: S3StorageLocation,
  options: { forcePathStyle?: boolean } = {},
): S3Client {
  const accessKeyId = getRequiredEnvVar("AWS_S3_ACCESS_KEY_ID");
  const secretAccessKey = getRequiredEnvVar("AWS_S3_SECRET_ACCESS_KEY");
  const region = location?.region ?? getLegacyS3StorageLocation().region;

  return new S3Client({
    region,
    ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
    // Presigned browser uploads do not provide the body while signing. The
    // SDK's default WHEN_SUPPORTED behavior otherwise signs the CRC32 of an
    // empty body, which S3 rejects when the browser PUTs the real file.
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

/**
 * Generate unique S3 key with user prefix
 * Format: users/{userId}/{timestamp}-{uuid}.{ext}
 * Only uses file extension from fileName, UUID ensures uniqueness
 */
export function generateS3Key(userId: string, fileName: string): string {
  const timestamp = Date.now();
  const uuid = uuidv4();

  // Extract file extension, default to empty string if none
  const lastDotIndex = fileName.lastIndexOf(".");
  const extension = lastDotIndex !== -1 ? fileName.substring(lastDotIndex) : "";

  return `${S3_USER_FILES_PREFIX}/${userId}/${timestamp}-${uuid}${extension}`;
}

/**
 * Generate presigned URL for file upload
 */
export async function generateS3UploadUrl(
  fileName: string,
  contentType: string,
  userId: string,
  contentLength?: number,
  requestedRegion?: S3StorageRegion,
): Promise<{
  uploadUrl: string;
  s3Key: string;
  storageLocation: S3StorageLocation;
}> {
  try {
    const storageLocation = resolveS3UploadLocation(requestedRegion);
    const s3Client = getS3Client(storageLocation);
    const s3Key = generateS3Key(userId, fileName);

    const command = new PutObjectCommand({
      Bucket: storageLocation.bucket,
      Key: s3Key,
      ContentType: contentType,
      ContentLength: contentLength,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: getS3UrlLifetimeSeconds(),
    });

    return { uploadUrl, s3Key, storageLocation };
  } catch (error) {
    console.error("Failed to generate S3 upload URL:", error);
    throw new Error(
      "Failed to generate upload URL: " +
        (error instanceof Error ? error.message : "Unknown error"),
    );
  }
}

/**
 * Generate presigned URL for file download
 */
export async function generateS3DownloadUrl(
  s3Key: string,
  storageLocation?: S3StorageLocation,
): Promise<string> {
  try {
    const location = storageLocation ?? getLegacyS3StorageLocation();
    // A production sandbox TLS path rejected the EU virtual-hosted bucket name
    // even though the S3 certificate is valid. EU files use S3's supported
    // path-style form so the bucket is not part of the TLS hostname. Keep
    // legacy and other regional URL shapes unchanged without incident evidence.
    const s3Client = getS3Client(location, {
      forcePathStyle: storageLocation?.region === "eu-central-1",
    });

    const command = new GetObjectCommand({
      Bucket: location.bucket,
      Key: s3Key,
    });

    const downloadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: getS3UrlLifetimeSeconds(),
    });

    return downloadUrl;
  } catch (error) {
    console.error("Failed to generate S3 download URL:", error);
    throw new Error(
      "Failed to generate download URL: " +
        (error instanceof Error ? error.message : "Unknown error"),
    );
  }
}

/**
 * Delete object from S3
 */
export async function deleteS3Object(
  s3Key: string,
  storageLocation?: S3StorageLocation,
): Promise<void> {
  try {
    const location = storageLocation ?? getLegacyS3StorageLocation();
    const s3Client = getS3Client(location);

    const command = new DeleteObjectCommand({
      Bucket: location.bucket,
      Key: s3Key,
    });

    await s3Client.send(command);
  } catch (error) {
    console.error("Failed to delete S3 object:", error);
    throw new Error(
      "Failed to delete S3 object: " +
        (error instanceof Error ? error.message : "Unknown error"),
    );
  }
}

/**
 * Get S3 object size in bytes.
 */
export async function getS3ObjectSizeBytes(
  s3Key: string,
  storageLocation?: S3StorageLocation,
): Promise<number> {
  try {
    const location = storageLocation ?? getLegacyS3StorageLocation();
    const s3Client = getS3Client(location);

    const command = new HeadObjectCommand({
      Bucket: location.bucket,
      Key: s3Key,
    });

    const result = await s3Client.send(command);
    if (typeof result.ContentLength !== "number") {
      throw new Error("S3 object ContentLength is missing");
    }
    return result.ContentLength;
  } catch (error) {
    console.error("Failed to fetch S3 object metadata:", error);
    throw new Error(
      "Failed to fetch S3 object metadata: " +
        (error instanceof Error ? error.message : "Unknown error"),
    );
  }
}
