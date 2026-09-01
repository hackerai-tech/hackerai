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
    delete process.env.S3_REGIONAL_STORAGE_ENABLED;
    delete process.env.AWS_S3_BUCKET_NAME_EU_CENTRAL_1;
    delete process.env.AWS_S3_BUCKET_NAME_US_EAST_1;
    delete process.env.AWS_S3_BUCKET_NAME_US_WEST_2;
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
      expect(result.storageLocation).toEqual({
        region: "us-east-1",
        bucket: "test-bucket",
      });
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

    it("routes enabled uploads to the requested regional bucket", async () => {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      (
        getSignedUrl as jest.MockedFunction<typeof getSignedUrl>
      ).mockResolvedValue("https://s3.amazonaws.com/signed-url");
      process.env.S3_REGIONAL_STORAGE_ENABLED = "true";
      process.env.AWS_S3_BUCKET_NAME_EU_CENTRAL_1 = "test-eu-bucket";

      const { generateS3UploadUrl } = await import("../s3Utils");
      const result = await generateS3UploadUrl(
        "test.pdf",
        "application/pdf",
        "user123",
        1024,
        "eu-central-1",
      );

      expect(result.storageLocation).toEqual({
        region: "eu-central-1",
        bucket: "test-eu-bucket",
      });
      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({ region: "eu-central-1" }),
      );
      expect(S3Client).toHaveBeenCalledWith(
        expect.not.objectContaining({ forcePathStyle: true }),
      );
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Bucket: "test-eu-bucket" }),
      );
    });

    it("keeps using legacy storage while regional routing is disabled", async () => {
      process.env.S3_REGIONAL_STORAGE_ENABLED = "false";
      process.env.AWS_S3_BUCKET_NAME_EU_CENTRAL_1 = "test-eu-bucket";

      const { resolveS3UploadLocation } = await import("../s3Utils");

      expect(resolveS3UploadLocation("eu-central-1")).toEqual({
        region: "us-east-1",
        bucket: "test-bucket",
      });
    });

    it("fails closed when an enabled regional bucket is missing", async () => {
      process.env.S3_REGIONAL_STORAGE_ENABLED = "true";
      const { resolveS3UploadLocation } = await import("../s3Utils");

      expect(() => resolveS3UploadLocation("eu-central-1")).toThrow(
        "AWS_S3_BUCKET_NAME_EU_CENTRAL_1",
      );
    });
  });

  describe("getStoredS3Location", () => {
    it("uses legacy fallback only when both locator fields are absent", async () => {
      const { getStoredS3Location } = await import("../s3Utils");

      expect(getStoredS3Location()).toBeUndefined();
      expect(getStoredS3Location("us-west-2", "  exact-west-bucket  ")).toEqual(
        { region: "us-west-2", bucket: "exact-west-bucket" },
      );
      expect(() => getStoredS3Location("us-west-2")).toThrow(
        "Incomplete S3 storage location metadata",
      );
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
      const { S3Client } = await import("@aws-sdk/client-s3");
      expect(S3Client).toHaveBeenCalledWith(
        expect.not.objectContaining({ forcePathStyle: true }),
      );
    });

    it("uses a path-style hostname for persisted EU files", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      (
        getSignedUrl as jest.MockedFunction<typeof getSignedUrl>
      ).mockResolvedValue("https://s3.eu-central-1.amazonaws.com/download-url");

      const { generateS3DownloadUrl } = await import("../s3Utils");
      await generateS3DownloadUrl("users/user123/123-uuid-test.pdf", {
        region: "eu-central-1",
        bucket: "test-eu-bucket",
      });

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: "eu-central-1",
          forcePathStyle: true,
        }),
      );
      expect(getSignedUrl).toHaveBeenCalled();
    });

    it("keeps virtual-hosted URLs for persisted non-EU files", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      (
        getSignedUrl as jest.MockedFunction<typeof getSignedUrl>
      ).mockResolvedValue(
        "https://test-west-bucket.s3.us-west-2.amazonaws.com/download-url",
      );

      const { generateS3DownloadUrl } = await import("../s3Utils");
      await generateS3DownloadUrl("users/user123/123-uuid-test.pdf", {
        region: "us-west-2",
        bucket: "test-west-bucket",
      });

      expect(S3Client).toHaveBeenCalledWith(
        expect.not.objectContaining({ forcePathStyle: true }),
      );
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
});
