import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import {
  getS3UrlLifetimeSeconds,
  S3_USER_FILES_PREFIX,
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
export function getS3Client(): S3Client {
  const accessKeyId = getRequiredEnvVar("AWS_S3_ACCESS_KEY_ID");
  const secretAccessKey = getRequiredEnvVar("AWS_S3_SECRET_ACCESS_KEY");
  const region = getRequiredEnvVar("AWS_S3_REGION");

  return new S3Client({
    region,
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
): Promise<{ uploadUrl: string; s3Key: string }> {
  try {
    const s3Client = getS3Client();
    const bucketName = getRequiredEnvVar("AWS_S3_BUCKET_NAME");
    const s3Key = generateS3Key(userId, fileName);

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: getS3UrlLifetimeSeconds(),
    });

    return { uploadUrl, s3Key };
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
export async function generateS3DownloadUrl(s3Key: string): Promise<string> {
  try {
    const s3Client = getS3Client();
    const bucketName = getRequiredEnvVar("AWS_S3_BUCKET_NAME");

    const command = new GetObjectCommand({
      Bucket: bucketName,
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
export async function deleteS3Object(s3Key: string): Promise<void> {
  try {
    const s3Client = getS3Client();
    const bucketName = getRequiredEnvVar("AWS_S3_BUCKET_NAME");

    const command = new DeleteObjectCommand({
      Bucket: bucketName,
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
