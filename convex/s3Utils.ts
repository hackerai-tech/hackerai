import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
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

export type S3ObjectTarget = {
  region: string;
  bucketName: string;
};

function getS3ObjectTarget(target?: S3ObjectTarget): S3ObjectTarget {
  return (
    target ?? {
      region: getRequiredEnvVar("AWS_S3_REGION"),
      bucketName: getRequiredEnvVar("AWS_S3_BUCKET_NAME"),
    }
  );
}

/**
 * Get S3 client with credentials from environment variables
 */
export function getS3Client(
  region = getRequiredEnvVar("AWS_S3_REGION"),
): S3Client {
  const accessKeyId = getRequiredEnvVar("AWS_S3_ACCESS_KEY_ID");
  const secretAccessKey = getRequiredEnvVar("AWS_S3_SECRET_ACCESS_KEY");

  return new S3Client({
    region,
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
): Promise<{ uploadUrl: string; s3Key: string }> {
  try {
    const s3Client = getS3Client();
    const bucketName = getRequiredEnvVar("AWS_S3_BUCKET_NAME");
    const s3Key = generateS3Key(userId, fileName);

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      ContentType: contentType,
      ContentLength: contentLength,
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

/** Generate a presigned upload URL for a trusted, pre-scoped S3 key. */
export async function generateS3UploadUrlForKey(
  s3Key: string,
  expiresIn = getS3UrlLifetimeSeconds(),
  target?: S3ObjectTarget,
): Promise<string> {
  const { region, bucketName } = getS3ObjectTarget(target);
  const s3Client = getS3Client(region);
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
  });

  return getSignedUrl(s3Client, command, {
    expiresIn,
  });
}

/**
 * Generate presigned URL for file download
 */
export async function generateS3DownloadUrl(
  s3Key: string,
  target?: S3ObjectTarget,
): Promise<string> {
  try {
    const { region, bucketName } = getS3ObjectTarget(target);
    const s3Client = getS3Client(region);

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

export type S3ObjectMetadata =
  | { exists: false }
  | { exists: true; lastModifiedMs: number | null; eTag: string | null };

/** Read object presence plus its S3-authoritative modification time and ETag. */
export async function getS3ObjectMetadata(
  s3Key: string,
  target?: S3ObjectTarget,
): Promise<S3ObjectMetadata> {
  const { region, bucketName } = getS3ObjectTarget(target);
  const s3Client = getS3Client(region);

  try {
    const result = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }),
    );
    return {
      exists: true,
      lastModifiedMs: result.LastModified?.getTime() ?? null,
      eTag: result.ETag ?? null,
    };
  } catch (error) {
    const record =
      error && typeof error === "object"
        ? (error as {
            name?: unknown;
            $metadata?: { httpStatusCode?: unknown };
          })
        : null;
    if (
      record?.name === "NotFound" ||
      record?.name === "NoSuchKey" ||
      record?.$metadata?.httpStatusCode === 404
    ) {
      return { exists: false };
    }
    if (record?.$metadata?.httpStatusCode === 403) {
      throw new Error(
        `S3 metadata access denied in ${region} (HTTP 403); verify s3:GetObject permission for the target key`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Copy a trusted object into another regional bucket. The copy runs inside S3,
 * so a MicroVM never has to download a cross-region workspace through NAT.
 * The destination precondition keeps a concurrent checkpoint from being
 * overwritten by the restore copy.
 */
export async function copyS3Object(
  s3Key: string,
  source: S3ObjectTarget,
  destination: S3ObjectTarget,
  destinationCondition: { ifMatch: string } | { ifNoneMatch: "*" },
): Promise<{ copied: boolean }> {
  const s3Client = getS3Client(destination.region);
  const encodedKey = s3Key.split("/").map(encodeURIComponent).join("/");
  try {
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: destination.bucketName,
        Key: s3Key,
        CopySource: `${source.bucketName}/${encodedKey}`,
        ...(destinationCondition && "ifMatch" in destinationCondition
          ? { IfMatch: destinationCondition.ifMatch }
          : { IfNoneMatch: "*" }),
      }),
    );
    return { copied: true };
  } catch (error) {
    const statusCode =
      error && typeof error === "object"
        ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata
            ?.httpStatusCode
        : undefined;
    if (statusCode === 409 || statusCode === 412) {
      return { copied: false };
    }
    throw error;
  }
}

/** Return whether an S3 object exists without treating a missing key as an error. */
export async function s3ObjectExists(
  s3Key: string,
  target?: S3ObjectTarget,
): Promise<boolean> {
  return (await getS3ObjectMetadata(s3Key, target)).exists;
}

/**
 * Delete object from S3
 */
export async function deleteS3Object(
  s3Key: string,
  target?: S3ObjectTarget,
): Promise<void> {
  try {
    const { region, bucketName } = getS3ObjectTarget(target);
    const s3Client = getS3Client(region);

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

/**
 * Get S3 object size in bytes.
 */
export async function getS3ObjectSizeBytes(s3Key: string): Promise<number> {
  try {
    const s3Client = getS3Client();
    const bucketName = getRequiredEnvVar("AWS_S3_BUCKET_NAME");

    const command = new HeadObjectCommand({
      Bucket: bucketName,
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
