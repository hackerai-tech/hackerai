/**
 * Real S3 metadata wrapper and generated-file action; only the AWS SDK
 * transport and Convex runtime context are fixtures.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConvexError } from "convex/values";

jest.mock("../lib/serviceFunctions", () => ({
  action: (config: unknown) => config,
}));
jest.mock("../_generated/api", () => ({
  internal: {
    fileStorage: {
      saveFileToDb: "internal.fileStorage.saveFileToDb",
      getFileByS3Key: "internal.fileStorage.getFileByS3Key",
    },
    s3Cleanup: {
      deleteS3ObjectAction: "internal.s3Cleanup.deleteS3ObjectAction",
    },
  },
}));
jest.mock("../lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("pdfjs-serverless", () => ({ getDocument: jest.fn() }));
jest.mock("isbinaryfile", () => ({ isBinaryFile: jest.fn() }));

// Imported after the mocks above; @jest/globals mocks are not hoisted here.
let getS3ObjectMetadataFailure: typeof import("../s3Utils").getS3ObjectMetadataFailure;
let getS3ObjectSizeBytes: typeof import("../s3Utils").getS3ObjectSizeBytes;
let saveSandboxGeneratedFile: any;

beforeAll(async () => {
  ({ getS3ObjectMetadataFailure, getS3ObjectSizeBytes } =
    await import("../s3Utils"));
  ({ saveSandboxGeneratedFile } = await import("../fileActions"));
});

const send = (
  new S3Client({}) as unknown as {
    send: jest.Mock<(command: unknown) => Promise<unknown>>;
  }
).send;

const PRIVATE_MESSAGE =
  "SENTINEL_SDK_MESSAGE https://sentinel-private-bucket.s3.amazonaws.com/users/user123/SENTINEL_FILE.zip";
const PRIVATE_VALUES = [
  "SENTINEL",
  "sentinel-private-bucket",
  "amazonaws",
  "user123",
  "NotFound",
  "Forbidden",
  "ECONNRESET",
];
const WRAPPER_PREFIX = "Failed to fetch S3 object metadata: ";

function sdkError(name: string, httpStatusCode?: unknown, code?: string) {
  return Object.assign(new Error(PRIVATE_MESSAGE), {
    name,
    ...(code ? { code } : {}),
    $metadata: {
      httpStatusCode,
      requestId: "SENTINEL_REQUEST_ID",
      extendedRequestId: "SENTINEL_EXTENDED_REQUEST_ID",
    },
  });
}

async function headFailure(original: unknown) {
  send.mockRejectedValueOnce(original);
  return getS3ObjectSizeBytes("users/user123/SENTINEL_FILE.zip", {
    region: "us-east-1",
    bucket: "sentinel-private-bucket",
  }).then(
    () => {
      throw new Error("Expected HEAD verification to fail");
    },
    (error: unknown) => error as Error,
  );
}

let consoleSpies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  send.mockReset();
  jest.mocked(getSignedUrl).mockReset();
  // The existing wrapper and action logs include the private sentinels.
  consoleSpies = [
    jest.spyOn(console, "error").mockImplementation(() => {}),
    jest.spyOn(console, "warn").mockImplementation(() => {}),
  ];
  process.env.AWS_S3_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_S3_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.AWS_S3_REGION = "us-east-1";
  process.env.AWS_S3_BUCKET_NAME = "test-bucket";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

describe("getS3ObjectSizeBytes failure diagnostics", () => {
  it.each([
    ["NotFound", 404, undefined, "not_found", 404],
    ["NoSuchBucket", 404, undefined, "not_found", 404],
    ["Forbidden", 403, undefined, "access_denied", 403],
    ["InvalidAccessKeyId", 403, undefined, "credentials", 403],
    ["CredentialsProviderError", undefined, undefined, "credentials", null],
    ["TimeoutError", undefined, undefined, "timeout", null],
    ["Error", undefined, "ECONNRESET", "transport", null],
    // The real Node SDK wraps a reset as TimeoutError while retaining its code.
    ["TimeoutError", undefined, "ECONNRESET", "transport", null],
    ["Error", undefined, "ERR_TLS_CERT_ALTNAME_INVALID", "transport", null],
    ["UnlistedServerError", 503, undefined, "http_5xx", 503],
    ["UnlistedClientError", 400, undefined, "http_4xx", 400],
    ["UnlistedRedirect", 301, undefined, "unknown", 301],
    ["UnlistedForbidden", 403, undefined, "access_denied", 403],
  ] as const)(
    "classifies %s (status %s, code %s) as %s/%s without changing the wrapper",
    async (name, status, code, reason, httpStatus) => {
      const error = await headFailure(sdkError(name, status, code));

      expect(error.name).toBe("Error");
      expect(error.message).toBe(WRAPPER_PREFIX + PRIVATE_MESSAGE);
      expect(error).not.toHaveProperty("cause");
      expect(getS3ObjectMetadataFailure(error)).toEqual({ reason, httpStatus });
    },
  );

  it.each([404.5, "404", 99, 600, Number.NaN, Infinity, -404, null])(
    "drops malformed HTTP status %p",
    async (status) => {
      const error = await headFailure(sdkError("UnlistedError", status));
      expect(getS3ObjectMetadataFailure(error)).toEqual({
        reason: "unknown",
        httpStatus: null,
      });
    },
  );

  it("keeps the original wrapper when diagnostic fields throw", async () => {
    const hostile = new Error(PRIVATE_MESSAGE);
    for (const field of ["$metadata", "name", "code"]) {
      Object.defineProperty(hostile, field, {
        get() {
          throw new Error("diagnostic getter failed");
        },
      });
    }
    const hostileError = await headFailure(hostile);
    expect(hostileError.message).toBe(WRAPPER_PREFIX + PRIVATE_MESSAGE);
    expect(getS3ObjectMetadataFailure(hostileError)).toEqual({
      reason: "unknown",
      httpStatus: null,
    });

    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error("proxy getter failed");
        },
      },
    );
    const proxyError = await headFailure(proxy);
    expect(proxyError.message).toBe(WRAPPER_PREFIX + "Unknown error");
    expect(getS3ObjectMetadataFailure(proxyError)).toEqual({
      reason: "unknown",
      httpStatus: null,
    });
  });

  it.each(["socket hang up", undefined, 404])(
    "reports non-error rejection %p as unknown",
    async (value) => {
      const error = await headFailure(value);
      expect(error.message).toBe(WRAPPER_PREFIX + "Unknown error");
      expect(getS3ObjectMetadataFailure(error)).toEqual({
        reason: "unknown",
        httpStatus: null,
      });
    },
  );

  it("distinguishes a HEAD response without ContentLength", async () => {
    send.mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
    const error = await getS3ObjectSizeBytes("users/user123/report.zip").then(
      () => undefined,
      (failure: Error) => failure,
    );
    expect(error?.message).toBe(
      WRAPPER_PREFIX + "S3 object ContentLength is missing",
    );
    expect(getS3ObjectMetadataFailure(error)).toEqual({
      reason: "missing_content_length",
      httpStatus: null,
    });
  });

  it.each([0, 1024])(
    "returns a %i-byte ContentLength unchanged",
    async (size) => {
      send.mockResolvedValueOnce({ ContentLength: size });
      await expect(
        getS3ObjectSizeBytes("users/user123/report.zip"),
      ).resolves.toBe(size);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([new Error("unrelated"), null, undefined, "NotFound", { reason: 1 }])(
    "returns a finite unknown fallback for unmarked value %p",
    (value) => {
      expect(getS3ObjectMetadataFailure(value)).toEqual({
        reason: "unknown",
        httpStatus: null,
      });
    },
  );
});

describe("saveSandboxGeneratedFile storage verification payload", () => {
  const args = {
    serviceKey: "test-service-key",
    userId: "user123",
    s3Key: "users/user123/SENTINEL_FILE.zip",
    name: "SENTINEL_FILE.zip",
    mediaType: "application/zip",
    size: 1024,
    s3Region: "eu-central-1",
    s3Bucket: "sentinel-private-bucket",
  };
  const verificationMessage =
    "The uploaded file could not be verified in storage. Retry delivery before sharing it.";
  const makeCtx = (published: unknown = null) => ({
    runMutation: jest.fn(async (..._args: unknown[]) => "file_123"),
    runQuery: jest.fn(async (..._args: unknown[]) => published),
    scheduler: { runAfter: jest.fn(async (..._args: unknown[]) => undefined) },
  });

  async function saveFailure(
    ctx: ReturnType<typeof makeCtx>,
  ): Promise<ConvexError<Record<string, string | number | null>>> {
    return saveSandboxGeneratedFile.handler(ctx, args).then(
      () => {
        throw new Error("Expected generated file save to fail");
      },
      (error: unknown) => error,
    );
  }

  it("retains only finite HEAD diagnostics in the reported ConvexError", async () => {
    send.mockRejectedValueOnce(sdkError("NotFound", 404));
    const ctx = makeCtx();

    const error = await saveFailure(ctx);

    expect(error).toBeInstanceOf(ConvexError);
    const expected = {
      code: "GENERATED_FILE_VERIFICATION_FAILED",
      message: verificationMessage,
      generated_file_verification_diagnostic_version: 1,
      storage_failure_reason: "not_found",
      storage_http_status: 404,
    };
    expect(error.data).toEqual(expected);
    // Exception reporting retains the serialized ConvexError message.
    expect(JSON.parse(error.message)).toEqual(expected);
    for (const value of PRIVATE_VALUES) {
      expect(error.message).not.toContain(value);
    }
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      "internal.s3Cleanup.deleteS3ObjectAction",
      { s3Key: args.s3Key, s3Region: args.s3Region, s3Bucket: args.s3Bucket },
    );
  });

  it("keeps an already-published object when a retry hits a transport failure", async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error(PRIVATE_MESSAGE), { code: "ECONNRESET" }),
    );
    const ctx = makeCtx({ s3Key: args.s3Key, user_id: args.userId });

    const error = await saveFailure(ctx);

    expect(error.data).toMatchObject({
      code: "GENERATED_FILE_VERIFICATION_FAILED",
      storage_failure_reason: "transport",
      storage_http_status: null,
    });
    for (const value of PRIVATE_VALUES) {
      expect(error.message).not.toContain(value);
    }
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("leaves an existing size-mismatch ConvexError unchanged", async () => {
    send.mockResolvedValueOnce({ ContentLength: args.size - 1 });
    const ctx = makeCtx();

    const error = await saveFailure(ctx);

    expect(error.data).toEqual({
      code: "GENERATED_FILE_SIZE_MISMATCH",
      message:
        "The uploaded file size does not match the source file. Wait for the file to finish writing and retry delivery.",
    });
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("publishes a verified zero-byte artifact", async () => {
    send.mockResolvedValueOnce({ ContentLength: 0 });
    jest
      .mocked(getSignedUrl)
      .mockResolvedValueOnce("https://download.example/file");
    const ctx = makeCtx();

    await expect(
      saveSandboxGeneratedFile.handler(ctx, { ...args, size: 0 }),
    ).resolves.toEqual({
      url: "https://download.example/file",
      fileId: "file_123",
      tokens: 0,
    });
    expect(ctx.runMutation).toHaveBeenCalledWith(
      "internal.fileStorage.saveFileToDb",
      expect.objectContaining({ s3Key: args.s3Key, size: 0 }),
    );
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});
