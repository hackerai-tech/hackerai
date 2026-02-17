import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Mock s3Utils module
jest.mock("../s3Utils");

// Mock Convex server functions
jest.mock("../_generated/server", () => ({
  action: jest.fn((config) => config),
  query: jest.fn((config) => config),
}));

// Mock chats module to avoid circular dependency
jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

// Mock fileActions module for rate limiting
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCheckFileUploadRateLimit = jest.fn<any>();
jest.mock("../fileActions", () => ({
  checkFileUploadRateLimit: mockCheckFileUploadRateLimit,
}));

// Mock internal API
jest.mock("../_generated/api", () => ({
  internal: {
    fileStorage: {
      getUserStorageUsage: "internal.fileStorage.getUserStorageUsage",
    },
  },
}));

describe("s3Actions", () => {
  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();

    // Reset validateServiceKey mock to no-op
    const { validateServiceKey } = await import("../lib/utils");
    const mockValidateServiceKey = validateServiceKey as jest.MockedFunction<
      typeof validateServiceKey
    >;
    mockValidateServiceKey.mockImplementation(() => {});

    // Reset checkFileUploadRateLimit mock to return success by default
    mockCheckFileUploadRateLimit.mockResolvedValue({
      remaining: 79,
      limit: 80,
      reset: Date.now() + 5 * 60 * 60 * 1000,
    });

    // Setup environment variables
    process.env.AWS_S3_ACCESS_KEY_ID = "test-access-key";
    process.env.AWS_S3_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.AWS_S3_REGION = "us-east-1";
    process.env.AWS_S3_BUCKET_NAME = "test-bucket";
  });

  describe("generateS3UploadUrlAction", () => {
    it("should generate upload URL for authenticated user", async () => {
      const { generateS3UploadUrl } = await import("../s3Utils");
      const mockGenerateS3UploadUrl =
        generateS3UploadUrl as jest.MockedFunction<typeof generateS3UploadUrl>;

      mockGenerateS3UploadUrl.mockResolvedValue({
        uploadUrl: "https://s3.amazonaws.com/test-upload-url",
        s3Key: "users/user123/123-uuid-test.pdf",
      });

      const { generateS3UploadUrlAction } = await import("../s3Actions");

      // Create mock context - rate limiting is handled by mocked checkFileUploadRateLimit
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockCtx: any = {
        auth: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getUserIdentity: jest.fn<any>().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        // Mock runQuery to return storage usage (user has space available)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runQuery: jest.fn<any>().mockResolvedValue({
          usedBytes: 1024 * 1024 * 1024, // 1 GB used
          maxBytes: 10 * 1024 * 1024 * 1024, // 10 GB max
          availableBytes: 9 * 1024 * 1024 * 1024, // 9 GB available
        }),
      };

      const result = await generateS3UploadUrlAction.handler(mockCtx, {
        fileName: "test.pdf",
        contentType: "application/pdf",
      });

      expect(result).toEqual({
        uploadUrl: "https://s3.amazonaws.com/test-upload-url",
        s3Key: "users/user123/123-uuid-test.pdf",
        rateLimit: {
          remaining: 79,
          limit: 80,
          reset: expect.any(Number),
        },
      });

      expect(mockGenerateS3UploadUrl).toHaveBeenCalledWith(
        "test.pdf",
        "application/pdf",
        "user123",
      );

      expect(mockCheckFileUploadRateLimit).toHaveBeenCalledWith(
        "user123",
        true,
      );
    });

    it("should throw error for unauthenticated user", async () => {
      const { generateS3UploadUrlAction } = await import("../s3Actions");

      // Create mock context with no user
      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue(null),
        },
      } as any;

      await expect(
        generateS3UploadUrlAction.handler(mockCtx, {
          fileName: "test.pdf",
          contentType: "application/pdf",
        }),
      ).rejects.toThrow("Unauthenticated");
    });

    it("should throw error for empty fileName", async () => {
      const { generateS3UploadUrlAction } = await import("../s3Actions");

      // Create mock context
      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
      } as any;

      await expect(
        generateS3UploadUrlAction.handler(mockCtx, {
          fileName: "",
          contentType: "application/pdf",
        }),
      ).rejects.toThrow("Invalid fileName");
    });

    it("should throw error for empty contentType", async () => {
      const { generateS3UploadUrlAction } = await import("../s3Actions");

      // Create mock context
      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
      } as any;

      await expect(
        generateS3UploadUrlAction.handler(mockCtx, {
          fileName: "test.pdf",
          contentType: "",
        }),
      ).rejects.toThrow("Invalid contentType");
    });

    it("should throw error for whitespace-only fileName", async () => {
      const { generateS3UploadUrlAction } = await import("../s3Actions");

      // Create mock context
      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
      } as any;

      await expect(
        generateS3UploadUrlAction.handler(mockCtx, {
          fileName: "   ",
          contentType: "application/pdf",
        }),
      ).rejects.toThrow("Invalid fileName");
    });

    it("should handle S3 utility errors gracefully", async () => {
      const { generateS3UploadUrl } = await import("../s3Utils");
      const mockGenerateS3UploadUrl =
        generateS3UploadUrl as jest.MockedFunction<typeof generateS3UploadUrl>;

      mockGenerateS3UploadUrl.mockRejectedValue(
        new Error("S3 service unavailable"),
      );

      const { generateS3UploadUrlAction } = await import("../s3Actions");

      // Create mock context with runQuery for storage check
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockCtx: any = {
        auth: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getUserIdentity: jest.fn<any>().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runQuery: jest.fn<any>().mockResolvedValue({
          usedBytes: 1024 * 1024 * 1024,
          maxBytes: 10 * 1024 * 1024 * 1024,
          availableBytes: 9 * 1024 * 1024 * 1024,
        }),
      };

      await expect(
        generateS3UploadUrlAction.handler(mockCtx, {
          fileName: "test.pdf",
          contentType: "application/pdf",
        }),
      ).rejects.toThrow("Failed to generate upload URL");
    });

    it("should accept various file types", async () => {
      const { generateS3UploadUrl } = await import("../s3Utils");
      const mockGenerateS3UploadUrl =
        generateS3UploadUrl as jest.MockedFunction<typeof generateS3UploadUrl>;

      const { generateS3UploadUrlAction } = await import("../s3Actions");

      const testCases = [
        { fileName: "image.png", contentType: "image/png" },
        { fileName: "document.pdf", contentType: "application/pdf" },
        { fileName: "data.csv", contentType: "text/csv" },
        { fileName: "notes.txt", contentType: "text/plain" },
      ];

      for (const testCase of testCases) {
        mockGenerateS3UploadUrl.mockClear();
        mockGenerateS3UploadUrl.mockResolvedValue({
          uploadUrl: "https://s3.amazonaws.com/test-upload-url",
          s3Key: `users/user123/123-uuid-${testCase.fileName}`,
        });

        // Create mock context with runQuery for storage check
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mockCtx: any = {
          auth: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            getUserIdentity: jest.fn<any>().mockResolvedValue({
              subject: "user123",
              email: "test@example.com",
            }),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          runQuery: jest.fn<any>().mockResolvedValue({
            usedBytes: 1024 * 1024 * 1024,
            maxBytes: 10 * 1024 * 1024 * 1024,
            availableBytes: 9 * 1024 * 1024 * 1024,
          }),
        };

        await generateS3UploadUrlAction.handler(mockCtx, testCase);

        expect(mockGenerateS3UploadUrl).toHaveBeenCalledWith(
          testCase.fileName,
          testCase.contentType,
          "user123",
        );
      }
    });

    it("should throw error when rate limit exceeded", async () => {
      // Import ConvexError for rate limit error
      const { ConvexError } = await import("convex/values");

      // Mock rate limit to throw error
      mockCheckFileUploadRateLimit.mockRejectedValue(
        new ConvexError({
          code: "FILE_UPLOAD_RATE_LIMIT",
          message:
            "You've reached your file upload limit of 80 files per 5 hours. Please try again after 2h 30m.",
        }),
      );

      const { generateS3UploadUrlAction } = await import("../s3Actions");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockCtx: any = {
        auth: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getUserIdentity: jest.fn<any>().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runQuery: jest.fn<any>().mockResolvedValue({
          usedBytes: 1024 * 1024 * 1024,
          maxBytes: 10 * 1024 * 1024 * 1024,
          availableBytes: 9 * 1024 * 1024 * 1024,
        }),
      };

      await expect(
        generateS3UploadUrlAction.handler(mockCtx, {
          fileName: "test.pdf",
          contentType: "application/pdf",
        }),
      ).rejects.toThrow("file upload limit");
    });

    it("should return undefined rateLimit when Redis is not configured", async () => {
      const { generateS3UploadUrl } = await import("../s3Utils");
      const mockGenerateS3UploadUrl =
        generateS3UploadUrl as jest.MockedFunction<typeof generateS3UploadUrl>;

      mockGenerateS3UploadUrl.mockResolvedValue({
        uploadUrl: "https://s3.amazonaws.com/test-upload-url",
        s3Key: "users/user123/123-uuid-test.pdf",
      });

      // Mock rate limit to return null (Redis not configured)
      mockCheckFileUploadRateLimit.mockResolvedValue(null);

      const { generateS3UploadUrlAction } = await import("../s3Actions");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockCtx: any = {
        auth: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getUserIdentity: jest.fn<any>().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runQuery: jest.fn<any>().mockResolvedValue({
          usedBytes: 1024 * 1024 * 1024,
          maxBytes: 10 * 1024 * 1024 * 1024,
          availableBytes: 9 * 1024 * 1024 * 1024,
        }),
      };

      const result = await generateS3UploadUrlAction.handler(mockCtx, {
        fileName: "test.pdf",
        contentType: "application/pdf",
      });

      expect(result).toEqual({
        uploadUrl: "https://s3.amazonaws.com/test-upload-url",
        s3Key: "users/user123/123-uuid-test.pdf",
        rateLimit: undefined,
      });
    });
  });

  describe("getFileUrlAction", () => {
    it("should generate presigned URL for S3 file", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;

      mockGenerateS3DownloadUrl.mockResolvedValue(
        "https://s3.amazonaws.com/test-bucket/presigned-download-url",
      );

      const { getFileUrlAction } = await import("../s3Actions");

      const mockFileId = "file123" as any;
      const mockFile = {
        _id: mockFileId,
        s3_key: "users/user123/123-uuid-test.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "test.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(mockFile),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlAction.handler(mockCtx, {
        fileId: mockFileId,
      });

      expect(result).toBe(
        "https://s3.amazonaws.com/test-bucket/presigned-download-url",
      );
      expect(mockGenerateS3DownloadUrl).toHaveBeenCalledWith(
        "users/user123/123-uuid-test.pdf",
      );
    });

    it("should return Convex URL for legacy file", async () => {
      const { getFileUrlAction } = await import("../s3Actions");

      const mockFileId = "file123" as any;
      const mockStorageId = "storage123" as any;
      const mockFile = {
        _id: mockFileId,
        s3_key: undefined,
        storage_id: mockStorageId,
        user_id: "user123",
        name: "test.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(mockFile),
        storage: {
          getUrl: jest
            .fn()
            .mockResolvedValue("https://convex.cloud/storage/file-url"),
        },
      } as any;

      const result = await getFileUrlAction.handler(mockCtx, {
        fileId: mockFileId,
      });

      expect(result).toBe("https://convex.cloud/storage/file-url");
      expect(mockCtx.storage.getUrl).toHaveBeenCalledWith(mockStorageId);
    });

    it("should throw error for unauthenticated user", async () => {
      const { getFileUrlAction } = await import("../s3Actions");

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue(null),
        },
      } as any;

      await expect(
        getFileUrlAction.handler(mockCtx, { fileId: "file123" as any }),
      ).rejects.toThrow("Unauthenticated");
    });

    it("should throw error for file not found", async () => {
      const { getFileUrlAction } = await import("../s3Actions");

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(null),
      } as any;

      await expect(
        getFileUrlAction.handler(mockCtx, { fileId: "file123" as any }),
      ).rejects.toThrow("File not found");
    });

    it("should throw error for access denied", async () => {
      const { getFileUrlAction } = await import("../s3Actions");

      const mockFileId = "file123" as any;
      const mockFile = {
        _id: mockFileId,
        s3_key: "users/user456/123-uuid-test.pdf",
        storage_id: undefined,
        user_id: "user456",
        name: "test.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(mockFile),
      } as any;

      await expect(
        getFileUrlAction.handler(mockCtx, { fileId: mockFileId }),
      ).rejects.toThrow("Access denied");
    });

    it("should throw error for file with no storage reference", async () => {
      const { getFileUrlAction } = await import("../s3Actions");

      const mockFileId = "file123" as any;
      const mockFile = {
        _id: mockFileId,
        s3_key: undefined,
        storage_id: undefined,
        user_id: "user123",
        name: "test.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(mockFile),
      } as any;

      await expect(
        getFileUrlAction.handler(mockCtx, { fileId: mockFileId }),
      ).rejects.toThrow("File has no storage reference");
    });

    it("should throw error for file with both storage references (invalid state)", async () => {
      const { getFileUrlAction } = await import("../s3Actions");

      const mockFileId = "file123" as any;
      const mockFile = {
        _id: mockFileId,
        s3_key: "users/user123/123-uuid-test.pdf",
        storage_id: "storage123" as any,
        user_id: "user123",
        name: "test.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(mockFile),
      } as any;

      await expect(
        getFileUrlAction.handler(mockCtx, { fileId: mockFileId }),
      ).rejects.toThrow("File has both S3 and Convex storage references");
    });

    it("should handle S3 download URL generation errors", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;

      mockGenerateS3DownloadUrl.mockRejectedValue(
        new Error("S3 service unavailable"),
      );

      const { getFileUrlAction } = await import("../s3Actions");

      const mockFileId = "file123" as any;
      const mockFile = {
        _id: mockFileId,
        s3_key: "users/user123/123-uuid-test.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "test.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(mockFile),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      await expect(
        getFileUrlAction.handler(mockCtx, { fileId: mockFileId }),
      ).rejects.toThrow("Failed to get file URL");
    });

    it("should handle Convex storage URL errors", async () => {
      const { getFileUrlAction } = await import("../s3Actions");

      const mockFileId = "file123" as any;
      const mockStorageId = "storage123" as any;
      const mockFile = {
        _id: mockFileId,
        s3_key: undefined,
        storage_id: mockStorageId,
        user_id: "user123",
        name: "test.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(mockFile),
        storage: {
          getUrl: jest.fn().mockResolvedValue(null),
        },
      } as any;

      await expect(
        getFileUrlAction.handler(mockCtx, { fileId: mockFileId }),
      ).rejects.toThrow("Failed to generate Convex storage URL");
    });
  });

  describe("getFileUrlsBatchAction", () => {
    it("should generate URLs for multiple S3 files", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;

      mockGenerateS3DownloadUrl
        .mockResolvedValueOnce("https://s3.amazonaws.com/file1-url")
        .mockResolvedValueOnce("https://s3.amazonaws.com/file2-url")
        .mockResolvedValueOnce("https://s3.amazonaws.com/file3-url");

      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;
      const mockFile3Id = "file3" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user123/file1.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile2 = {
        _id: mockFile2Id,
        s3_key: "users/user123/file2.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file2.pdf",
        media_type: "application/pdf",
        size: 2048,
        file_token_size: 200,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile3 = {
        _id: mockFile3Id,
        s3_key: "users/user123/file3.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file3.pdf",
        media_type: "application/pdf",
        size: 3072,
        file_token_size: 300,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(mockFile1)
          .mockResolvedValueOnce(mockFile2)
          .mockResolvedValueOnce(mockFile3),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsBatchAction.handler(mockCtx, {
        fileIds: [mockFile1Id, mockFile2Id, mockFile3Id],
      });

      expect(result).toEqual({
        file1: "https://s3.amazonaws.com/file1-url",
        file2: "https://s3.amazonaws.com/file2-url",
        file3: "https://s3.amazonaws.com/file3-url",
      });
    });

    it("should generate URLs for mixed S3 and Convex files", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;

      mockGenerateS3DownloadUrl.mockResolvedValue(
        "https://s3.amazonaws.com/file1-url",
      );

      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user123/file1.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile2 = {
        _id: mockFile2Id,
        s3_key: undefined,
        storage_id: "storage123" as any,
        user_id: "user123",
        name: "file2.pdf",
        media_type: "application/pdf",
        size: 2048,
        file_token_size: 200,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(mockFile1)
          .mockResolvedValueOnce(mockFile2),
        storage: {
          getUrl: jest
            .fn()
            .mockResolvedValue("https://convex.cloud/storage/file2-url"),
        },
      } as any;

      const result = await getFileUrlsBatchAction.handler(mockCtx, {
        fileIds: [mockFile1Id, mockFile2Id],
      });

      expect(result).toEqual({
        file1: "https://s3.amazonaws.com/file1-url",
        file2: "https://convex.cloud/storage/file2-url",
      });
    });

    it("should skip files user doesn't own (access control)", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;

      mockGenerateS3DownloadUrl.mockResolvedValue(
        "https://s3.amazonaws.com/file1-url",
      );

      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user123/file1.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile2 = {
        _id: mockFile2Id,
        s3_key: "users/user456/file2.pdf",
        storage_id: undefined,
        user_id: "user456", // Different owner
        name: "file2.pdf",
        media_type: "application/pdf",
        size: 2048,
        file_token_size: 200,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(mockFile1)
          .mockResolvedValueOnce(mockFile2),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsBatchAction.handler(mockCtx, {
        fileIds: [mockFile1Id, mockFile2Id],
      });

      // Only file1 should be in the result (user owns it)
      expect(result).toEqual({
        file1: "https://s3.amazonaws.com/file1-url",
      });
      expect(result.file2).toBeUndefined();
    });

    it("should skip files not found", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;

      mockGenerateS3DownloadUrl.mockResolvedValue(
        "https://s3.amazonaws.com/file1-url",
      );

      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user123/file1.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(mockFile1)
          .mockResolvedValueOnce(null), // File not found
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsBatchAction.handler(mockCtx, {
        fileIds: [mockFile1Id, mockFile2Id],
      });

      // Only file1 should be in the result
      expect(result).toEqual({
        file1: "https://s3.amazonaws.com/file1-url",
      });
      expect(result.file2).toBeUndefined();
    });

    it("should skip files with no storage reference", async () => {
      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: undefined,
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(mockFile1),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsBatchAction.handler(mockCtx, {
        fileIds: [mockFile1Id],
      });

      expect(result).toEqual({});
    });

    it("should skip files with both storage references (invalid state)", async () => {
      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user123/file1.pdf",
        storage_id: "storage123" as any,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest.fn().mockResolvedValue(mockFile1),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsBatchAction.handler(mockCtx, {
        fileIds: [mockFile1Id],
      });

      expect(result).toEqual({});
    });

    it("should handle partial failures gracefully", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;

      mockGenerateS3DownloadUrl
        .mockResolvedValueOnce("https://s3.amazonaws.com/file1-url")
        .mockRejectedValueOnce(new Error("S3 service unavailable"))
        .mockResolvedValueOnce("https://s3.amazonaws.com/file3-url");

      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;
      const mockFile3Id = "file3" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user123/file1.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile2 = {
        _id: mockFile2Id,
        s3_key: "users/user123/file2.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file2.pdf",
        media_type: "application/pdf",
        size: 2048,
        file_token_size: 200,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile3 = {
        _id: mockFile3Id,
        s3_key: "users/user123/file3.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file3.pdf",
        media_type: "application/pdf",
        size: 3072,
        file_token_size: 300,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(mockFile1)
          .mockResolvedValueOnce(mockFile2)
          .mockResolvedValueOnce(mockFile3),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsBatchAction.handler(mockCtx, {
        fileIds: [mockFile1Id, mockFile2Id, mockFile3Id],
      });

      // File2 should be skipped due to error, but file1 and file3 should be returned
      expect(result).toEqual({
        file1: "https://s3.amazonaws.com/file1-url",
        file3: "https://s3.amazonaws.com/file3-url",
      });
      expect(result.file2).toBeUndefined();
    });

    it("should throw error for unauthenticated user", async () => {
      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue(null),
        },
      } as any;

      await expect(
        getFileUrlsBatchAction.handler(mockCtx, { fileIds: ["file1" as any] }),
      ).rejects.toThrow("Unauthenticated");
    });

    it("should throw error for batch size exceeding limit", async () => {
      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
      } as any;

      // Create array with 51 file IDs (exceeds limit of 50)
      const fileIds = Array.from({ length: 51 }, (_, i) => `file${i}` as any);

      await expect(
        getFileUrlsBatchAction.handler(mockCtx, { fileIds }),
      ).rejects.toThrow("Batch size exceeds limit");
    });

    it("should handle empty file IDs array", async () => {
      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
      } as any;

      const result = await getFileUrlsBatchAction.handler(mockCtx, {
        fileIds: [],
      });

      expect(result).toEqual({});
    });

    it("should return empty map when all files are inaccessible", async () => {
      const { getFileUrlsBatchAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user456/file1.pdf",
        storage_id: undefined,
        user_id: "user456", // Different owner
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile2 = {
        _id: mockFile2Id,
        s3_key: "users/user789/file2.pdf",
        storage_id: undefined,
        user_id: "user789", // Different owner
        name: "file2.pdf",
        media_type: "application/pdf",
        size: 2048,
        file_token_size: 200,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: "user123",
            email: "test@example.com",
          }),
        },
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(mockFile1)
          .mockResolvedValueOnce(mockFile2),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsBatchAction.handler(mockCtx, {
        fileIds: [mockFile1Id, mockFile2Id],
      });

      expect(result).toEqual({});
    });
  });

  describe("getFileUrlsByFileIdsAction", () => {
    it("should generate URLs for multiple S3 files using service key", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const { validateServiceKey } = await import("../lib/utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;
      const mockValidateServiceKey = validateServiceKey as jest.MockedFunction<
        typeof validateServiceKey
      >;

      mockGenerateS3DownloadUrl
        .mockResolvedValueOnce("https://s3.amazonaws.com/file1-url")
        .mockResolvedValueOnce("https://s3.amazonaws.com/file2-url");

      const { getFileUrlsByFileIdsAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user123/file1.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile2 = {
        _id: mockFile2Id,
        s3_key: "users/user123/file2.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file2.pdf",
        media_type: "application/pdf",
        size: 2048,
        file_token_size: 200,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(mockFile1)
          .mockResolvedValueOnce(mockFile2),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsByFileIdsAction.handler(mockCtx, {
        serviceKey: "test-service-key",
        fileIds: [mockFile1Id, mockFile2Id],
      });

      expect(mockValidateServiceKey).toHaveBeenCalledWith("test-service-key");
      expect(result).toEqual([
        "https://s3.amazonaws.com/file1-url",
        "https://s3.amazonaws.com/file2-url",
      ]);
    });

    it("should handle mixed S3 and Convex files", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;

      mockGenerateS3DownloadUrl.mockResolvedValue(
        "https://s3.amazonaws.com/file1-url",
      );

      const { getFileUrlsByFileIdsAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user123/file1.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile2 = {
        _id: mockFile2Id,
        s3_key: undefined,
        storage_id: "storage123" as any,
        user_id: "user123",
        name: "file2.pdf",
        media_type: "application/pdf",
        size: 2048,
        file_token_size: 200,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(mockFile1)
          .mockResolvedValueOnce(mockFile2),
        storage: {
          getUrl: jest
            .fn()
            .mockResolvedValue("https://convex.cloud/storage/file2-url"),
        },
      } as any;

      const result = await getFileUrlsByFileIdsAction.handler(mockCtx, {
        serviceKey: "test-service-key",
        fileIds: [mockFile1Id, mockFile2Id],
      });

      expect(result).toEqual([
        "https://s3.amazonaws.com/file1-url",
        "https://convex.cloud/storage/file2-url",
      ]);
    });

    it("should return null for files not found", async () => {
      const { getFileUrlsByFileIdsAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;

      const mockCtx = {
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsByFileIdsAction.handler(mockCtx, {
        serviceKey: "test-service-key",
        fileIds: [mockFile1Id, mockFile2Id],
      });

      expect(result).toEqual([null, null]);
    });

    it("should throw error for invalid service key", async () => {
      const { validateServiceKey } = await import("../lib/utils");
      const mockValidateServiceKey = validateServiceKey as jest.MockedFunction<
        typeof validateServiceKey
      >;

      mockValidateServiceKey.mockImplementation(() => {
        throw new Error("Invalid service key");
      });

      const { getFileUrlsByFileIdsAction } = await import("../s3Actions");

      await expect(
        getFileUrlsByFileIdsAction.handler({} as any, {
          serviceKey: "invalid-key",
          fileIds: ["file1" as any],
        }),
      ).rejects.toThrow("Invalid service key");
    });

    it("should throw error for batch size exceeding limit", async () => {
      const { getFileUrlsByFileIdsAction } = await import("../s3Actions");

      const mockCtx = {} as any;

      // Create array with 51 file IDs (exceeds limit of 50)
      const fileIds = Array.from({ length: 51 }, (_, i) => `file${i}` as any);

      await expect(
        getFileUrlsByFileIdsAction.handler(mockCtx, {
          serviceKey: "test-service-key",
          fileIds,
        }),
      ).rejects.toThrow("Batch size exceeds limit");
    });

    it("should handle partial failures gracefully", async () => {
      const { generateS3DownloadUrl } = await import("../s3Utils");
      const mockGenerateS3DownloadUrl =
        generateS3DownloadUrl as jest.MockedFunction<
          typeof generateS3DownloadUrl
        >;

      mockGenerateS3DownloadUrl
        .mockResolvedValueOnce("https://s3.amazonaws.com/file1-url")
        .mockRejectedValueOnce(new Error("S3 service unavailable"))
        .mockResolvedValueOnce("https://s3.amazonaws.com/file3-url");

      const { getFileUrlsByFileIdsAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;
      const mockFile2Id = "file2" as any;
      const mockFile3Id = "file3" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: "users/user123/file1.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile2 = {
        _id: mockFile2Id,
        s3_key: "users/user123/file2.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file2.pdf",
        media_type: "application/pdf",
        size: 2048,
        file_token_size: 200,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockFile3 = {
        _id: mockFile3Id,
        s3_key: "users/user123/file3.pdf",
        storage_id: undefined,
        user_id: "user123",
        name: "file3.pdf",
        media_type: "application/pdf",
        size: 3072,
        file_token_size: 300,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        runQuery: jest
          .fn()
          .mockResolvedValueOnce(mockFile1)
          .mockResolvedValueOnce(mockFile2)
          .mockResolvedValueOnce(mockFile3),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsByFileIdsAction.handler(mockCtx, {
        serviceKey: "test-service-key",
        fileIds: [mockFile1Id, mockFile2Id, mockFile3Id],
      });

      // File2 should return null due to error
      expect(result).toEqual([
        "https://s3.amazonaws.com/file1-url",
        null,
        "https://s3.amazonaws.com/file3-url",
      ]);
    });

    it("should handle empty file IDs array", async () => {
      const { getFileUrlsByFileIdsAction } = await import("../s3Actions");

      const mockCtx = {} as any;

      const result = await getFileUrlsByFileIdsAction.handler(mockCtx, {
        serviceKey: "test-service-key",
        fileIds: [],
      });

      expect(result).toEqual([]);
    });

    it("should return null for files with no storage reference", async () => {
      const { getFileUrlsByFileIdsAction } = await import("../s3Actions");

      const mockFile1Id = "file1" as any;

      const mockFile1 = {
        _id: mockFile1Id,
        s3_key: undefined,
        storage_id: undefined,
        user_id: "user123",
        name: "file1.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: true,
        _creationTime: Date.now(),
      };

      const mockCtx = {
        runQuery: jest.fn().mockResolvedValue(mockFile1),
        storage: {
          getUrl: jest.fn(),
        },
      } as any;

      const result = await getFileUrlsByFileIdsAction.handler(mockCtx, {
        serviceKey: "test-service-key",
        fileIds: [mockFile1Id],
      });

      expect(result).toEqual([null]);
    });
  });
});
