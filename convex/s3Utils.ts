/**
 * S3 utilities for Convex environment
 * These functions work in the Convex Node.js runtime
 */
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "stream";

/**
 * Create S3 client with environment variables
 */
export const createS3Client = () => {
  return new S3Client({
    region: process.env.AWS_S3_REGION!,
    credentials: {
      accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
    },
  });
};

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME!;

/**
 * Generate a deterministic S3 key for a user/file
 */
export const generateS3Key = (userId: string, fileName: string): string => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 12);
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `uploads/${userId}/${timestamp}-${random}-${sanitized}`;
};

/**
 * Generate a presigned URL for downloading a file from S3
 */
export const generateS3DownloadUrl = async (s3Key: string): Promise<string> => {
  const client = createS3Client();
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
  });

  const url = await getSignedUrl(client, command, { expiresIn: 3600 }); // 1 hour
  return url;
};

/**
 * Generate presigned URLs for multiple S3 keys in parallel.
 * Returns a mapping from s3Key -> url.
 */
export const generateS3DownloadUrls = async (
  s3Keys: Array<string>,
  expiresInSeconds: number = 3600,
): Promise<Record<string, string>> => {
  if (s3Keys.length === 0) return {};

  const client = createS3Client();
  const result: Record<string, string> = {};

  console.log(`[S3] Generating presigned URLs for ${s3Keys.length} keys`);
  console.log(`[S3] Current time: ${new Date().toISOString()}`);
  console.log(`[S3] Bucket: ${BUCKET_NAME}`);
  console.log(`[S3] Region: ${process.env.AWS_S3_REGION}`);

  await Promise.all(
    s3Keys.map(async (key) => {
      try {
        const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
        const url = await getSignedUrl(client, command, {
          expiresIn: expiresInSeconds,
        });
        result[key] = url;
        console.log(`[S3] Successfully generated URL for: ${key}`);
      } catch (error) {
        console.error(`[S3] Failed to generate URL for key: ${key}`, error);
        throw error;
      }
    }),
  );

  return result;
};

/**
 * Generate a presigned URL for uploading a file to S3
 */
export const generateS3UploadUrl = async (
  s3Key: string,
  contentType: string,
): Promise<string> => {
  const client = createS3Client();
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
    ContentType: contentType,
  });
  return await getSignedUrl(client, command, { expiresIn: 3600 });
};

/**
 * Delete multiple files from S3 in a single request
 * Can handle up to 1000 files per call
 */
export const deleteS3Files = async (s3Keys: string[]): Promise<void> => {
  if (s3Keys.length === 0) return;

  const client = createS3Client();
  const command = new DeleteObjectsCommand({
    Bucket: BUCKET_NAME,
    Delete: {
      Objects: s3Keys.map((key) => ({ Key: key })),
      Quiet: true, // Don't return info about deleted objects
    },
  });

  await client.send(command);
};

/**
 * Delete a single file from S3
 */
export const deleteS3File = async (s3Key: string): Promise<void> => {
  const client = createS3Client();
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
  });

  await client.send(command);
};

/**
 * Get file content from S3
 */
export const getS3FileContent = async (s3Key: string): Promise<Buffer> => {
  const client = createS3Client();
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
  });

  const response = await client.send(command);
  const body: any = response.Body;

  // Browser-style ReadableStream (not expected in Convex Node runtime, but handle defensively)
  if (body && typeof body.getReader === "function") {
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  // Node.js Readable stream
  if (body && typeof body.on === "function") {
    const nodeStream = body as Readable;
    const chunks: Buffer[] = [];
    return await new Promise<Buffer>((resolve, reject) => {
      nodeStream.on("data", (chunk: any) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      nodeStream.once("end", () => resolve(Buffer.concat(chunks)));
      nodeStream.once("error", reject);
    });
  }

  // If Body is already a Buffer/Uint8Array
  if (Buffer.isBuffer(body)) {
    return body as Buffer;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  throw new Error("Unsupported S3 Body stream type");
};
