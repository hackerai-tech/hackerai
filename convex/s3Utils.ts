/**
 * S3 Utilities for Convex Node.js Runtime
 *
 * Provides type-safe, production-ready utilities for S3 operations including:
 * - Presigned URL generation (upload/download)
 * - File operations (upload, delete, retrieve)
 * - Retry logic with exponential backoff
 * - Comprehensive error handling
 * - Input validation
 *
 * @module convex/s3Utils
 */

import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "stream";

// =============================================================================
// CONFIGURATION & VALIDATION
// =============================================================================

/**
 * Validate required environment variables at module load
 */
const validateEnvironment = (): void => {
  const required = [
    "AWS_S3_REGION",
    "AWS_S3_ACCESS_KEY_ID",
    "AWS_S3_SECRET_ACCESS_KEY",
    "AWS_S3_BUCKET_NAME",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required S3 environment variables: ${missing.join(", ")}. ` +
        `Please configure these in your Convex environment settings.`,
    );
  }
};

// Validate on module load
validateEnvironment();

const AWS_REGION = process.env.AWS_S3_REGION!;
const AWS_ACCESS_KEY_ID = process.env.AWS_S3_ACCESS_KEY_ID!;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_S3_SECRET_ACCESS_KEY!;
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME!;

// =============================================================================
// TYPES
// =============================================================================

interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

interface S3ErrorContext {
  operation: string;
  bucket?: string;
  key?: string;
  attemptNumber?: number;
}

// =============================================================================
// S3 CLIENT
// =============================================================================

/**
 * Create S3 client with validated credentials
 * Client is created fresh for each operation to avoid connection pooling issues
 */
export const createS3Client = (): S3Client => {
  return new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1, // We handle retries manually for better control
  });
};

// =============================================================================
// ERROR HANDLING
// =============================================================================

/**
 * Determine if an S3 error is retryable
 */
const isRetryableError = (error: unknown): boolean => {
  if (error instanceof S3ServiceException) {
    // Retry on server errors (5xx) and throttling
    if (error.$metadata?.httpStatusCode) {
      const statusCode = error.$metadata.httpStatusCode;
      if (statusCode >= 500) return true;
      if (statusCode === 429) return true; // Too Many Requests
    }

    // Retry on specific error codes
    const retryableCodes = [
      "ServiceUnavailable",
      "SlowDown",
      "RequestTimeout",
      "InternalError",
    ];
    if (retryableCodes.includes(error.name)) return true;
  }

  // Retry on network errors
  if (error instanceof Error) {
    const networkErrors = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"];
    if (networkErrors.some((code) => error.message.includes(code))) {
      return true;
    }
  }

  return false;
};

/**
 * Create descriptive error message for S3 operations
 */
const createErrorMessage = (
  error: unknown,
  context: S3ErrorContext,
): string => {
  const baseMsg = `S3 ${context.operation} failed`;
  const details: string[] = [];

  if (context.bucket) details.push(`bucket=${context.bucket}`);
  if (context.key) details.push(`key=${context.key}`);
  if (context.attemptNumber) details.push(`attempt=${context.attemptNumber}`);

  let errorInfo = "Unknown error";
  if (error instanceof S3ServiceException) {
    errorInfo = `${error.name}: ${error.message}`;
  } else if (error instanceof Error) {
    errorInfo = error.message;
  }

  return `${baseMsg} (${details.join(", ")}): ${errorInfo}`;
};

// =============================================================================
// RETRY LOGIC
// =============================================================================

/**
 * Execute S3 operation with exponential backoff retry logic
 *
 * @param operation - Async function to execute
 * @param context - Error context for logging
 * @param options - Retry configuration
 * @returns Promise with operation result
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  context: S3ErrorContext,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const config: RetryOptions = {
    maxRetries: 3,
    initialDelayMs: 100,
    maxDelayMs: 5000,
    backoffMultiplier: 2,
    ...options,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry on last attempt or non-retryable errors
      if (attempt > config.maxRetries || !isRetryableError(error)) {
        const errorMsg = createErrorMessage(error, {
          ...context,
          attemptNumber: attempt,
        });
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
        config.maxDelayMs,
      );

      console.warn(
        `${context.operation} failed (attempt ${attempt}/${config.maxRetries + 1}), ` +
          `retrying in ${delay}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

// =============================================================================
// S3 KEY GENERATION
// =============================================================================

/**
 * Generate a deterministic, unique S3 key for a file
 *
 * Format: uploads/{userId}/{timestamp}-{random}-{sanitizedFileName}
 *
 * @param userId - User ID for namespacing
 * @param fileName - Original file name
 * @returns S3 key string
 */
export const generateS3Key = (userId: string, fileName: string): string => {
  console.log(`[S3] generateS3Key called - userId: ${userId}, fileName: ${fileName}`);

  // Validate inputs
  if (!userId || typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Invalid userId: must be a non-empty string");
  }

  if (!fileName || typeof fileName !== "string" || fileName.trim().length === 0) {
    throw new Error("Invalid fileName: must be a non-empty string");
  }

  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 12);

  // Sanitize filename: remove special characters, limit length
  const sanitized = fileName
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .substring(0, 100);

  const key = `uploads/${userId}/${timestamp}-${random}-${sanitized}`;
  console.log(`[S3] Generated S3 key: ${key}`);

  return key;
};

// =============================================================================
// PRESIGNED URL GENERATION
// =============================================================================

/**
 * Generate a presigned URL for downloading a file from S3
 *
 * @param s3Key - S3 object key
 * @param expiresInSeconds - URL expiration time (default: 3600 = 1 hour)
 * @returns Presigned download URL
 */
export const generateS3DownloadUrl = async (
  s3Key: string,
  expiresInSeconds: number = 3600,
): Promise<string> => {
  console.log(`[S3] generateS3DownloadUrl called - key: ${s3Key}, expires: ${expiresInSeconds}s`);

  // Validate inputs
  if (!s3Key || typeof s3Key !== "string" || s3Key.trim().length === 0) {
    throw new Error("Invalid s3Key: must be a non-empty string");
  }

  if (expiresInSeconds <= 0 || expiresInSeconds > 604800) {
    throw new Error("Invalid expiresInSeconds: must be between 1 and 604800 (7 days)");
  }

  const url = await withRetry(
    async () => {
      const client = createS3Client();
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
      });

      const signedUrl = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
      console.log(`[S3] Generated download URL for ${s3Key} (expires in ${expiresInSeconds}s)`);
      return signedUrl;
    },
    {
      operation: "generateDownloadUrl",
      bucket: BUCKET_NAME,
      key: s3Key,
    },
  );

  return url;
};

/**
 * Generate presigned download URLs for multiple S3 keys in parallel
 *
 * @param s3Keys - Array of S3 object keys
 * @param expiresInSeconds - URL expiration time (default: 3600 = 1 hour)
 * @returns Map of s3Key -> presigned URL
 */
export const generateS3DownloadUrls = async (
  s3Keys: Array<string>,
  expiresInSeconds: number = 3600,
): Promise<Record<string, string>> => {
  if (!Array.isArray(s3Keys)) {
    throw new Error("Invalid s3Keys: must be an array");
  }

  if (s3Keys.length === 0) return {};

  if (s3Keys.length > 100) {
    throw new Error("Cannot generate more than 100 URLs at once");
  }

  console.log(`[S3] Generating presigned URLs for ${s3Keys.length} keys`);
  console.log(`[S3] Expiration: ${expiresInSeconds}s (${Math.floor(expiresInSeconds / 60)}m)`);

  const client = createS3Client();
  const result: Record<string, string> = {};

  await Promise.all(
    s3Keys.map(async (key) => {
      // Each URL generation gets its own retry logic
      const url = await withRetry(
        async () => {
          const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
          return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
        },
        {
          operation: "generateDownloadUrl",
          bucket: BUCKET_NAME,
          key,
        },
      );
      result[key] = url;
    }),
  );

  console.log(`[S3] Successfully generated ${Object.keys(result).length} URLs`);
  return result;
};

/**
 * Generate a presigned URL for uploading a file to S3
 *
 * @param s3Key - S3 object key
 * @param contentType - MIME type of the file
 * @param expiresInSeconds - URL expiration time (default: 3600 = 1 hour)
 * @returns Presigned upload URL
 */
export const generateS3UploadUrl = async (
  s3Key: string,
  contentType: string,
  expiresInSeconds: number = 3600,
): Promise<string> => {
  console.log(`[S3] generateS3UploadUrl called - key: ${s3Key}, contentType: ${contentType}, expires: ${expiresInSeconds}s`);

  // Validate inputs
  if (!s3Key || typeof s3Key !== "string" || s3Key.trim().length === 0) {
    throw new Error("Invalid s3Key: must be a non-empty string");
  }

  if (typeof contentType !== "string") {
    throw new Error("Invalid contentType: must be a string");
  }

  // Use default MIME type for unknown/empty content types
  const normalizedContentType = contentType.trim().length === 0
    ? "application/octet-stream"
    : contentType;

  if (expiresInSeconds <= 0 || expiresInSeconds > 3600) {
    throw new Error("Invalid expiresInSeconds: must be between 1 and 3600 (1 hour)");
  }

  const url = await withRetry(
    async () => {
      const client = createS3Client();
      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        ContentType: normalizedContentType,
      });

      const signedUrl = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
      console.log(`[S3] Generated upload URL for ${s3Key} with contentType ${normalizedContentType} (expires in ${expiresInSeconds}s)`);
      return signedUrl;
    },
    {
      operation: "generateUploadUrl",
      bucket: BUCKET_NAME,
      key: s3Key,
    },
  );

  return url;
};

// =============================================================================
// FILE OPERATIONS
// =============================================================================

/**
 * Delete a single file from S3
 *
 * @param s3Key - S3 object key to delete
 */
export const deleteS3File = async (s3Key: string): Promise<void> => {
  if (!s3Key || typeof s3Key !== "string" || s3Key.trim().length === 0) {
    throw new Error("Invalid s3Key: must be a non-empty string");
  }

  await withRetry(
    async () => {
      const client = createS3Client();
      const command = new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
      });

      await client.send(command);
    },
    {
      operation: "deleteFile",
      bucket: BUCKET_NAME,
      key: s3Key,
    },
  );

  console.log(`[S3] Successfully deleted: ${s3Key}`);
};

/**
 * Delete multiple files from S3 in a single request (batch operation)
 * Can handle up to 1000 files per call
 *
 * @param s3Keys - Array of S3 object keys to delete
 */
export const deleteS3Files = async (s3Keys: string[]): Promise<void> => {
  if (!Array.isArray(s3Keys)) {
    throw new Error("Invalid s3Keys: must be an array");
  }

  if (s3Keys.length === 0) return;

  if (s3Keys.length > 1000) {
    throw new Error("Cannot delete more than 1000 files at once");
  }

  await withRetry(
    async () => {
      const client = createS3Client();
      const command = new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: {
          Objects: s3Keys.map((key) => ({ Key: key })),
          Quiet: true, // Don't return info about deleted objects
        },
      });

      await client.send(command);
    },
    {
      operation: "deleteFiles",
      bucket: BUCKET_NAME,
    },
  );

  console.log(`[S3] Successfully deleted ${s3Keys.length} files`);
};

/**
 * Get file content from S3 as a Buffer
 *
 * Handles different stream types from AWS SDK (Node.js streams, browser streams)
 *
 * @param s3Key - S3 object key
 * @returns File content as Buffer
 */
export const getS3FileContent = async (s3Key: string): Promise<Buffer> => {
  console.log(`[S3] getS3FileContent called - key: ${s3Key}`);

  if (!s3Key || typeof s3Key !== "string" || s3Key.trim().length === 0) {
    throw new Error("Invalid s3Key: must be a non-empty string");
  }

  return withRetry(
    async () => {
      const client = createS3Client();
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
      });

      console.log(`[S3] Fetching file content for ${s3Key}`);
      const response = await client.send(command);
      const body: any = response.Body;

      console.log(`[S3] Received response for ${s3Key}, ContentLength: ${response.ContentLength}, ContentType: ${response.ContentType}`);

      if (!body) {
        throw new Error("S3 object has no body");
      }

      // Handle browser-style ReadableStream (unlikely in Convex, but defensive)
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

      // Handle Node.js Readable stream
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

      // Handle Buffer/Uint8Array directly
      if (Buffer.isBuffer(body)) {
        return body;
      }

      if (body instanceof Uint8Array) {
        return Buffer.from(body);
      }

      throw new Error(`Unsupported S3 Body stream type: ${typeof body}`);
    },
    {
      operation: "getFileContent",
      bucket: BUCKET_NAME,
      key: s3Key,
    },
  );
};
