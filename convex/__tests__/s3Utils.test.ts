import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { S3Client } from "@aws-sdk/client-s3";

// Mock AWS SDK modules
jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/s3-request-presigner");

describe("s3Utils", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AWS_S3_ACCESS_KEY_ID = "test-access-key";
    process.env.AWS_S3_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.AWS_S3_REGION = "us-east-1";
    process.env.AWS_S3_BUCKET_NAME = "test-bucket";
  });

  describe("generateS3Key", () => {
    it("should generate S3 key with correct format", async () => {
      const { generateS3Key } = await import("../s3Utils");
      const userId = "user123";
      const fileName = "test.pdf";

      const s3Key = generateS3Key(userId, fileName);

      // Format: users/{userId}/{timestamp}-{uuid}.{ext}
      // UUID is mocked as "test-uuid-{counter}" in tests
      expect(s3Key).toMatch(/^users\/user123\/\d+-test-uuid-\d+\.pdf$/);
    });

    it("should generate unique keys for same user and filename", async () => {
      const { generateS3Key } = await import("../s3Utils");
      const userId = "user123";
      const fileName = "test.pdf";

      const key1 = generateS3Key(userId, fileName);
      const key2 = generateS3Key(userId, fileName);

      expect(key1).not.toBe(key2);
    });
  });

  describe("getS3Client", () => {
    it("should create S3 client with correct credentials", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const { getS3Client } = await import("../s3Utils");

      getS3Client();

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "us-east-1",
          requestChecksumCalculation: "WHEN_REQUIRED",
          credentials: expect.objectContaining({
            accessKeyId: "test-access-key",
            secretAccessKey: "test-secret-key",
          }),
        }),
      );
    });

    it("should throw error if credentials are missing", async () => {
      delete process.env.AWS_S3_ACCESS_KEY_ID;
      delete process.env.AWS_S3_SECRET_ACCESS_KEY;
      delete process.env.AWS_S3_REGION;
      delete process.env.AWS_S3_BUCKET_NAME;

      // Force re-import to get new instance with missing env vars
      jest.resetModules();
      const { getS3Client } = await import("../s3Utils");

      expect(() => getS3Client()).toThrow();
    });
  });

  describe("generateS3UploadUrl", () => {
    it("should generate presigned upload URL and S3 key", async () => {
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
        typeof getSignedUrl
      >;
      mockGetSignedUrl.mockResolvedValue("https://s3.amazonaws.com/signed-url");

      const { generateS3UploadUrl } = await import("../s3Utils");

      const result = await generateS3UploadUrl(
        "test.pdf",
        "application/pdf",
        "user123",
        1024,
      );

      expect(result).toHaveProperty("uploadUrl");
      expect(result).toHaveProperty("s3Key");
      expect(result.uploadUrl).toBe("https://s3.amazonaws.com/signed-url");
      // Format: users/{userId}/{timestamp}-{uuid}.{ext}
      // UUID is mocked as "test-uuid-{counter}" in tests
      expect(result.s3Key).toMatch(/^users\/user123\/\d+-test-uuid-\d+\.pdf$/);
      expect(mockGetSignedUrl).toHaveBeenCalled();
    });

    it("should bind expected content length into the PutObject command", async () => {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
        typeof getSignedUrl
      >;
      mockGetSignedUrl.mockResolvedValue("https://s3.amazonaws.com/signed-url");

      const { generateS3UploadUrl } = await import("../s3Utils");

      await generateS3UploadUrl("test.pdf", "application/pdf", "user123", 1024);

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentLength: 1024,
        }),
      );
    });

    it("should use correct expiration time", async () => {
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
        typeof getSignedUrl
      >;
      mockGetSignedUrl.mockResolvedValue("https://s3.amazonaws.com/signed-url");

      const { generateS3UploadUrl } = await import("../s3Utils");

      await generateS3UploadUrl("test.pdf", "application/pdf", "user123", 1024);

      const callArgs = mockGetSignedUrl.mock.calls[0];
      expect(callArgs[2]).toEqual(expect.objectContaining({ expiresIn: 3600 }));
    });
  });

  describe("generateS3UploadUrlForKey", () => {
    it("presigns the trusted workspace key without a content-length constraint", async () => {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
        typeof getSignedUrl
      >;
      mockGetSignedUrl.mockResolvedValue("https://s3.amazonaws.com/workspace");
      const { generateS3UploadUrlForKey } = await import("../s3Utils");

      await expect(
        generateS3UploadUrlForKey(
          "users/user_123/microvm-workspace/v1/workspace.tar.gz",
        ),
      ).resolves.toBe("https://s3.amazonaws.com/workspace");
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: "users/user_123/microvm-workspace/v1/workspace.tar.gz",
      });
    });

    it("presigns against an explicit regional target without changing attachment configuration", async () => {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
        typeof getSignedUrl
      >;
      mockGetSignedUrl.mockResolvedValue("https://s3.amazonaws.com/workspace");
      const { generateS3UploadUrlForKey } = await import("../s3Utils");

      await generateS3UploadUrlForKey("workspace.tar.gz", 28_800, {
        region: "eu-west-1",
        bucketName: "regional-workspace-bucket",
      });

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({ region: "eu-west-1" }),
      );
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: "regional-workspace-bucket",
        Key: "workspace.tar.gz",
      });
      expect(process.env.AWS_S3_BUCKET_NAME).toBe("test-bucket");
    });
  });

  describe("generateS3DownloadUrl", () => {
    it("should generate presigned download URL", async () => {
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
        typeof getSignedUrl
      >;
      mockGetSignedUrl.mockResolvedValue(
        "https://s3.amazonaws.com/download-url",
      );

      const { generateS3DownloadUrl } = await import("../s3Utils");

      const url = await generateS3DownloadUrl(
        "users/user123/123-uuid-test.pdf",
      );

      expect(url).toBe("https://s3.amazonaws.com/download-url");
      expect(mockGetSignedUrl).toHaveBeenCalled();
    });
  });

  describe("deleteS3Object", () => {
    it("should delete S3 object", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const mockSend = jest.fn().mockResolvedValue({});
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () =>
          ({
            send: mockSend,
          }) as unknown as S3Client,
      );

      const { deleteS3Object } = await import("../s3Utils");

      await deleteS3Object("users/user123/123-uuid-test.pdf");

      expect(mockSend).toHaveBeenCalled();
    });

    it("should handle deletion errors gracefully", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const mockSend = jest.fn().mockRejectedValue(new Error("Delete failed"));
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () =>
          ({
            send: mockSend,
          }) as unknown as S3Client,
      );

      const { deleteS3Object } = await import("../s3Utils");

      await expect(
        deleteS3Object("users/user123/123-uuid-test.pdf"),
      ).rejects.toThrow("Delete failed");
    });
  });

  describe("s3ObjectExists", () => {
    it("returns true when S3 can read the object metadata", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const mockSend = jest.fn().mockResolvedValue({ ContentLength: 42 });
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () => ({ send: mockSend }) as unknown as S3Client,
      );
      const { s3ObjectExists } = await import("../s3Utils");

      await expect(s3ObjectExists("workspace.tar.gz")).resolves.toBe(true);
    });

    it("returns false only for an authoritative missing-object response", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const mockSend = jest.fn().mockRejectedValue({
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () => ({ send: mockSend }) as unknown as S3Client,
      );
      const { s3ObjectExists } = await import("../s3Utils");

      await expect(s3ObjectExists("workspace.tar.gz")).resolves.toBe(false);
    });

    it("does not hide storage outages as an empty workspace", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const outage = new Error("S3 unavailable");
      const mockSend = jest.fn().mockRejectedValue(outage);
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () => ({ send: mockSend }) as unknown as S3Client,
      );
      const { s3ObjectExists } = await import("../s3Utils");

      await expect(s3ObjectExists("workspace.tar.gz")).rejects.toBe(outage);
    });

    it("reports the region and required permission for access-denied metadata reads", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const accessDenied = {
        name: "Unknown",
        $metadata: { httpStatusCode: 403 },
      };
      const mockSend = jest.fn().mockRejectedValue(accessDenied);
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () => ({ send: mockSend }) as unknown as S3Client,
      );
      const { getS3ObjectMetadata } = await import("../s3Utils");

      const metadataPromise = getS3ObjectMetadata("workspace.tar.gz", {
        region: "eu-west-1",
        bucketName: "workspace-eu",
      });

      await expect(metadataPromise).rejects.toThrow(
        "S3 metadata access denied in eu-west-1 (HTTP 403); verify s3:GetObject permission for the target key",
      );
      await expect(metadataPromise).rejects.toHaveProperty(
        "cause",
        accessDenied,
      );
    });

    it("returns S3's server-side modification time for regional selection", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const lastModified = new Date("2026-08-24T04:00:00.000Z");
      const mockSend = jest
        .fn()
        .mockResolvedValue({ LastModified: lastModified, ETag: '"etag-42"' });
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () => ({ send: mockSend }) as unknown as S3Client,
      );
      const { getS3ObjectMetadata } = await import("../s3Utils");

      await expect(
        getS3ObjectMetadata("workspace.tar.gz", {
          region: "us-west-2",
          bucketName: "workspace-west",
        }),
      ).resolves.toEqual({
        exists: true,
        lastModifiedMs: lastModified.getTime(),
        eTag: '"etag-42"',
      });
    });
  });

  describe("copyS3Object", () => {
    it("copies a workspace into the destination region server-side", async () => {
      const { S3Client, CopyObjectCommand } =
        await import("@aws-sdk/client-s3");
      const mockSend = jest.fn().mockResolvedValue({});
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () => ({ send: mockSend }) as unknown as S3Client,
      );
      const { copyS3Object } = await import("../s3Utils");

      await expect(
        copyS3Object(
          "users/user%2F123/microvm-workspace/v1/workspace.tar.gz",
          { region: "us-west-2", bucketName: "workspace-west" },
          { region: "eu-west-1", bucketName: "workspace-eu" },
          { ifMatch: '"destination-etag"' },
        ),
      ).resolves.toEqual({ copied: true });

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({ region: "eu-west-1" }),
      );
      expect(CopyObjectCommand).toHaveBeenCalledWith({
        Bucket: "workspace-eu",
        Key: "users/user%2F123/microvm-workspace/v1/workspace.tar.gz",
        CopySource:
          "workspace-west/users/user%252F123/microvm-workspace/v1/workspace.tar.gz",
        IfMatch: '"destination-etag"',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("preserves a concurrently updated destination checkpoint", async () => {
      const { S3Client, CopyObjectCommand } =
        await import("@aws-sdk/client-s3");
      const mockSend = jest.fn().mockRejectedValue({
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      });
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () => ({ send: mockSend }) as unknown as S3Client,
      );
      const { copyS3Object } = await import("../s3Utils");

      await expect(
        copyS3Object(
          "workspace.tar.gz",
          { region: "us-west-2", bucketName: "workspace-west" },
          { region: "us-east-1", bucketName: "workspace-east" },
          { ifNoneMatch: "*" },
        ),
      ).resolves.toEqual({ copied: false });
      expect(CopyObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ IfNoneMatch: "*" }),
      );
    });

    it("propagates a conditional conflict when the destination may be absent", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const conflict = {
        name: "ConditionalRequestConflict",
        $metadata: { httpStatusCode: 409 },
      };
      const mockSend = jest.fn().mockRejectedValue(conflict);
      (S3Client as jest.MockedClass<typeof S3Client>).mockImplementation(
        () => ({ send: mockSend }) as unknown as S3Client,
      );
      const { copyS3Object } = await import("../s3Utils");

      await expect(
        copyS3Object(
          "workspace.tar.gz",
          { region: "us-west-2", bucketName: "workspace-west" },
          { region: "us-east-1", bucketName: "workspace-east" },
          { ifNoneMatch: "*" },
        ),
      ).rejects.toBe(conflict);
    });
  });
});
