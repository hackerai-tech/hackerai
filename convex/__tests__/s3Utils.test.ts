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
      );

      expect(result).toHaveProperty("uploadUrl");
      expect(result).toHaveProperty("s3Key");
      expect(result.uploadUrl).toBe("https://s3.amazonaws.com/signed-url");
      // Format: users/{userId}/{timestamp}-{uuid}.{ext}
      // UUID is mocked as "test-uuid-{counter}" in tests
      expect(result.s3Key).toMatch(/^users\/user123\/\d+-test-uuid-\d+\.pdf$/);
      expect(mockGetSignedUrl).toHaveBeenCalled();
    });

    it("should use correct expiration time", async () => {
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
        typeof getSignedUrl
      >;
      mockGetSignedUrl.mockResolvedValue("https://s3.amazonaws.com/signed-url");

      const { generateS3UploadUrl } = await import("../s3Utils");

      await generateS3UploadUrl("test.pdf", "application/pdf", "user123");

      const callArgs = mockGetSignedUrl.mock.calls[0];
      expect(callArgs[2]).toEqual(expect.objectContaining({ expiresIn: 3600 }));
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
});
