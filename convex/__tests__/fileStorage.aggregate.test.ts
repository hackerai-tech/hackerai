import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
  MutationCtx: {},
}));
jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
    null: jest.fn(() => "null"),
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    array: jest.fn(() => "array"),
    boolean: jest.fn(() => "boolean"),
  },
  ConvexError: class ConvexError extends Error {
    data: unknown;
    constructor(data: unknown) {
      super(
        typeof data === "string" ? data : (data as { message: string }).message,
      );
      this.data = data;
      this.name = "ConvexError";
    }
  },
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));
jest.mock("../../lib/utils/file-utils", () => ({
  isSupportedImageMediaType: jest.fn(),
}));
jest.mock("../_generated/api", () => ({
  internal: {
    fileStorage: {
      purgeExpiredUnattachedFiles:
        "internal.fileStorage.purgeExpiredUnattachedFiles",
      getFileById: "internal.fileStorage.getFileById",
      saveFileToDb: "internal.fileStorage.saveFileToDb",
    },
    s3Cleanup: {
      deleteS3ObjectAction: "internal.s3Cleanup.deleteS3ObjectAction",
    },
  },
}));

// Define mocks after jest.mock calls for convex/values
const mockFileCountAggregate = {
  count: jest.fn<any>().mockResolvedValue(0),
  sum: jest.fn<any>().mockResolvedValue(0),
  insert: jest.fn<any>().mockResolvedValue(undefined),
  insertIfDoesNotExist: jest.fn<any>().mockResolvedValue(undefined),
  delete: jest.fn<any>().mockResolvedValue(undefined),
  deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
};

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: mockFileCountAggregate,
}));

describe("fileStorage - Aggregate Integration", () => {
  const testUserId = "test-user-123";
  const testFileId = "test-file-id" as Id<"files">;
  // 10 GB in bytes
  const MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
  type FileLookupQueryCtx = {
    db: {
      get: (_id: Id<"files">) => Promise<Doc<"files"> | null>;
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    // Reset mocks to default values
    mockFileCountAggregate.sum.mockResolvedValue(0);
  });

  describe("service file retrieval ownership", () => {
    it("returns only storage URL metadata for file lookups", async () => {
      const { getFilesByIds } = await import("../fileStorage");
      const storedFile = {
        _id: testFileId,
        s3_key: "users/test-user/file.pdf",
        user_id: testUserId,
        name: "file.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 123,
        content: "large extracted content",
        is_attached: true,
        _creationTime: 123456,
      } as Doc<"files">;
      const mockDbGet = jest
        .fn<(_id: Id<"files">) => Promise<Doc<"files"> | null>>()
        .mockResolvedValue(storedFile);
      const mockCtx = {
        db: {
          get: mockDbGet,
        },
      } satisfies FileLookupQueryCtx;

      const result = await getFilesByIds.handler(
        mockCtx as unknown as QueryCtx,
        {
          fileIds: [testFileId],
        },
      );

      expect(result).toEqual([
        {
          _id: testFileId,
          s3_key: "users/test-user/file.pdf",
          user_id: testUserId,
          name: "file.pdf",
          media_type: "application/pdf",
          size: 1024,
        },
      ]);
      expect(result[0]).not.toHaveProperty("content");
      expect(result[0]).not.toHaveProperty("file_token_size");
      expect(result[0]).not.toHaveProperty("is_attached");
      expect(result[0]).not.toHaveProperty("_creationTime");
    });

    it("should only return token counts for files owned by the requested user", async () => {
      const { getFileTokensByFileIds } = await import("../fileStorage");
      const ownedFileId = "owned-file-id" as Id<"files">;
      const victimFileId = "victim-file-id" as Id<"files">;
      const mockCtx: any = {
        db: {
          get: jest
            .fn<any>()
            .mockResolvedValueOnce({
              _id: ownedFileId,
              user_id: testUserId,
              file_token_size: 123,
            })
            .mockResolvedValueOnce({
              _id: victimFileId,
              user_id: "other-user",
              file_token_size: 999,
            }),
        },
      };

      const result = await getFileTokensByFileIds.handler(mockCtx, {
        serviceKey: "test-service-key",
        userId: testUserId,
        fileIds: [ownedFileId, victimFileId],
      });

      expect(result).toEqual([123, 0]);
    });

    it("should not return file content or metadata for unowned files", async () => {
      const { isSupportedImageMediaType } =
        await import("../../lib/utils/file-utils");
      const mockIsSupportedImageMediaType =
        isSupportedImageMediaType as jest.MockedFunction<
          typeof isSupportedImageMediaType
        >;
      mockIsSupportedImageMediaType.mockReturnValue(false);

      const { getFileContentByFileIds } = await import("../fileStorage");
      const victimFileId = "victim-file-id" as Id<"files">;
      const mockCtx: any = {
        db: {
          get: jest.fn<any>().mockResolvedValue({
            _id: victimFileId,
            user_id: "other-user",
            name: "secret.txt",
            media_type: "text/plain",
            content: "private content",
            file_token_size: 999,
          }),
        },
      };

      const result = await getFileContentByFileIds.handler(mockCtx, {
        serviceKey: "test-service-key",
        userId: testUserId,
        fileIds: [victimFileId],
      });

      expect(result).toEqual([
        {
          id: victimFileId,
          name: "Unknown",
          mediaType: "unknown",
          content: null,
          tokenSize: 0,
        },
      ]);
    });

    it("should not return file metadata for unowned files", async () => {
      const { getFileMetadataByFileIds } = await import("../fileStorage");
      const victimFileId = "victim-file-id" as Id<"files">;
      const mockCtx: any = {
        db: {
          get: jest.fn<any>().mockResolvedValue({
            _id: victimFileId,
            user_id: "other-user",
            name: "secret.txt",
            media_type: "text/plain",
            s3_key: undefined,
          }),
        },
      };

      const result = await getFileMetadataByFileIds.handler(mockCtx, {
        serviceKey: "test-service-key",
        userId: testUserId,
        fileIds: [victimFileId],
      });

      expect(result).toEqual([null]);
    });
  });

  describe("saveFileToDb", () => {
    it("should insert file into aggregate using insertIfDoesNotExist", async () => {
      const mockFile = {
        _id: testFileId,
        user_id: testUserId,
        name: "test.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: false,
      };

      const unique = jest.fn<any>().mockResolvedValue(null);
      const mockCtx: any = {
        db: {
          query: jest.fn<any>().mockReturnValue({
            withIndex: jest.fn<any>().mockReturnValue({ unique }),
          }),
          insert: jest.fn<any>().mockResolvedValue(testFileId),
          get: jest.fn<any>().mockResolvedValue(mockFile),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;
      const result = await saveFileToDb.handler(mockCtx, {
        s3Key: "users/test-user-123/test.pdf",
        userId: testUserId,
        name: "test.pdf",
        mediaType: "application/pdf",
        size: 1024,
        fileTokenSize: 100,
        trustedServiceGenerated: true,
      });

      expect(result).toBe(testFileId);
      expect(mockCtx.db.insert).toHaveBeenCalledWith(
        "files",
        expect.objectContaining({
          user_id: testUserId,
          s3_key: "users/test-user-123/test.pdf",
          name: "test.pdf",
          is_attached: false,
        }),
      );
      expect(mockFileCountAggregate.insertIfDoesNotExist).toHaveBeenCalledWith(
        mockCtx,
        mockFile,
      );
    });

    it("should reject metadata saves without an S3 key", async () => {
      const mockCtx: any = {
        db: {
          query: jest.fn<any>(),
          insert: jest.fn<any>(),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;

      await expect(
        saveFileToDb.handler(mockCtx, {
          userId: testUserId,
          name: "legacy.pdf",
          mediaType: "application/pdf",
          size: 1024,
          fileTokenSize: 100,
        }),
      ).rejects.toMatchObject({
        data: expect.objectContaining({ code: "S3_KEY_REQUIRED" }),
      });

      expect(mockCtx.db.query).not.toHaveBeenCalled();
      expect(mockCtx.db.insert).not.toHaveBeenCalled();
    });

    it("should check storage limit before saving file", async () => {
      // User has 9 GB used
      const usedBytes = 9 * 1024 * 1024 * 1024;
      mockFileCountAggregate.sum.mockResolvedValue(usedBytes);

      const unique = jest.fn<any>().mockResolvedValue(null);
      const mockCtx: any = {
        db: {
          query: jest.fn<any>().mockReturnValue({
            withIndex: jest.fn<any>().mockReturnValue({ unique }),
          }),
          insert: jest.fn<any>().mockResolvedValue(testFileId),
          get: jest.fn<any>().mockResolvedValue(null),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;

      // Try to upload a 500 MB file (should succeed, under limit)
      const smallFileSize = 500 * 1024 * 1024;
      await saveFileToDb.handler(mockCtx, {
        s3Key: "users/test-user-123/small.pdf",
        userId: testUserId,
        name: "small.pdf",
        mediaType: "application/pdf",
        size: smallFileSize,
        fileTokenSize: 100,
        trustedServiceGenerated: true,
      });

      expect(mockCtx.db.insert).toHaveBeenCalled();
    });

    it("should throw error when storage limit exceeded", async () => {
      // User has 9.5 GB used
      const usedBytes = 9.5 * 1024 * 1024 * 1024;
      mockFileCountAggregate.sum.mockResolvedValue(usedBytes);

      const unique = jest.fn<any>().mockResolvedValue(null);
      const mockCtx: any = {
        db: {
          query: jest.fn<any>().mockReturnValue({
            withIndex: jest.fn<any>().mockReturnValue({ unique }),
          }),
          insert: jest.fn<any>().mockResolvedValue(testFileId),
          get: jest.fn<any>().mockResolvedValue(null),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;

      // Try to upload a 1 GB file (should fail, exceeds limit)
      const largeFileSize = 1 * 1024 * 1024 * 1024;
      await expect(
        saveFileToDb.handler(mockCtx, {
          s3Key: "users/test-user-123/large.pdf",
          userId: testUserId,
          name: "large.pdf",
          mediaType: "application/pdf",
          size: largeFileSize,
          fileTokenSize: 100,
          trustedServiceGenerated: true,
        }),
      ).rejects.toThrow("Storage limit exceeded");

      expect(mockCtx.db.insert).not.toHaveBeenCalled();
    });

    it("should finalize an existing S3 upload reservation without double-counting storage", async () => {
      const reservedFile = {
        _id: testFileId,
        s3_key: "users/test-user-123/file.pdf",
        user_id: testUserId,
        name: "file.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 0,
        is_attached: false,
      };
      const unique = jest.fn<any>().mockResolvedValue(reservedFile);
      const mockCtx: any = {
        db: {
          query: jest.fn<any>().mockReturnValue({
            withIndex: jest.fn<any>().mockReturnValue({ unique }),
          }),
          patch: jest.fn<any>().mockResolvedValue(undefined),
          insert: jest.fn<any>(),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;
      const result = await saveFileToDb.handler(mockCtx, {
        s3Key: "users/test-user-123/file.pdf",
        userId: testUserId,
        name: "file.pdf",
        mediaType: "application/pdf",
        size: 1024,
        fileTokenSize: 100,
      });

      expect(result).toBe(testFileId);
      expect(mockCtx.db.patch).toHaveBeenCalledWith(
        testFileId,
        expect.objectContaining({
          file_token_size: 100,
        }),
      );
      expect(mockCtx.db.insert).not.toHaveBeenCalled();
      expect(mockFileCountAggregate.sum).not.toHaveBeenCalled();
      expect(
        mockFileCountAggregate.insertIfDoesNotExist,
      ).not.toHaveBeenCalled();
    });

    it("should reject S3 saves without a reservation", async () => {
      const unique = jest.fn<any>().mockResolvedValue(null);
      const mockCtx: any = {
        db: {
          query: jest.fn<any>().mockReturnValue({
            withIndex: jest.fn<any>().mockReturnValue({ unique }),
          }),
          insert: jest.fn<any>(),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;
      await expect(
        saveFileToDb.handler(mockCtx, {
          s3Key: "users/test-user-123/file.pdf",
          userId: testUserId,
          name: "file.pdf",
          mediaType: "application/pdf",
          size: 1024,
          fileTokenSize: 100,
        }),
      ).rejects.toMatchObject({
        data: expect.objectContaining({ code: "MISSING_UPLOAD_RESERVATION" }),
      });

      expect(mockCtx.db.insert).not.toHaveBeenCalled();
      expect(mockFileCountAggregate.sum).not.toHaveBeenCalled();
    });

    it("should allow trusted service-generated S3 saves without a reservation", async () => {
      const unique = jest.fn<any>().mockResolvedValue(null);
      const mockFile = {
        _id: testFileId,
        s3_key: "users/test-user-123/generated.zip",
        user_id: testUserId,
        name: "generated.zip",
        media_type: "application/zip",
        size: 1024,
        file_token_size: 0,
        is_attached: false,
      };
      const mockCtx: any = {
        db: {
          query: jest.fn<any>().mockReturnValue({
            withIndex: jest.fn<any>().mockReturnValue({ unique }),
          }),
          insert: jest.fn<any>().mockResolvedValue(testFileId),
          get: jest.fn<any>().mockResolvedValue(mockFile),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;
      const result = await saveFileToDb.handler(mockCtx, {
        s3Key: "users/test-user-123/generated.zip",
        userId: testUserId,
        name: "generated.zip",
        mediaType: "application/zip",
        size: 1024,
        fileTokenSize: 0,
        trustedServiceGenerated: true,
      });

      expect(result).toBe(testFileId);
      expect(mockCtx.db.insert).toHaveBeenCalled();
      expect(mockFileCountAggregate.insertIfDoesNotExist).toHaveBeenCalledWith(
        mockCtx,
        mockFile,
      );
    });
  });

  describe("createPendingS3File", () => {
    it("should reserve storage for pending S3 uploads", async () => {
      const mockFile = {
        _id: testFileId,
        s3_key: "users/test-user-123/file.pdf",
        user_id: testUserId,
        name: "file.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 0,
        is_attached: false,
      };
      const unique = jest.fn<any>().mockResolvedValue(null);
      const mockCtx: any = {
        db: {
          query: jest.fn<any>().mockReturnValue({
            withIndex: jest.fn<any>().mockReturnValue({ unique }),
          }),
          insert: jest.fn<any>().mockResolvedValue(testFileId),
          get: jest.fn<any>().mockResolvedValue(mockFile),
        },
      };

      const { createPendingS3File } = (await import("../fileStorage")) as any;
      const result = await createPendingS3File.handler(mockCtx, {
        s3Key: "users/test-user-123/file.pdf",
        userId: testUserId,
        name: "file.pdf",
        mediaType: "application/pdf",
        size: 1024,
      });

      expect(result).toBe(testFileId);
      expect(mockCtx.db.insert).toHaveBeenCalledWith(
        "files",
        expect.objectContaining({
          s3_key: "users/test-user-123/file.pdf",
          user_id: testUserId,
          size: 1024,
          file_token_size: 0,
          is_attached: false,
        }),
      );
      expect(mockFileCountAggregate.insertIfDoesNotExist).toHaveBeenCalledWith(
        mockCtx,
        mockFile,
      );
    });
  });

  describe("getUserStorageUsage", () => {
    it("should return storage usage when aggregate is available", async () => {
      const usedBytes = 5 * 1024 * 1024 * 1024; // 5 GB
      mockFileCountAggregate.sum.mockResolvedValue(usedBytes);

      const mockCtx: any = {};

      const { getUserStorageUsage } = (await import("../fileStorage")) as any;
      const result = await getUserStorageUsage.handler(mockCtx, {
        userId: testUserId,
      });

      expect(result).toEqual({
        usedBytes,
        maxBytes: MAX_STORAGE_BYTES,
        availableBytes: MAX_STORAGE_BYTES - usedBytes,
      });
    });

    it("should return 0 available bytes when at limit", async () => {
      mockFileCountAggregate.sum.mockResolvedValue(MAX_STORAGE_BYTES);

      const mockCtx: any = {};

      const { getUserStorageUsage } = (await import("../fileStorage")) as any;
      const result = await getUserStorageUsage.handler(mockCtx, {
        userId: testUserId,
      });

      expect(result).toEqual({
        usedBytes: MAX_STORAGE_BYTES,
        maxBytes: MAX_STORAGE_BYTES,
        availableBytes: 0,
      });
    });

    it("should return 0 available bytes when over limit", async () => {
      const overLimitBytes = MAX_STORAGE_BYTES + 1024;
      mockFileCountAggregate.sum.mockResolvedValue(overLimitBytes);

      const mockCtx: any = {};

      const { getUserStorageUsage } = (await import("../fileStorage")) as any;
      const result = await getUserStorageUsage.handler(mockCtx, {
        userId: testUserId,
      });

      expect(result).toEqual({
        usedBytes: overLimitBytes,
        maxBytes: MAX_STORAGE_BYTES,
        availableBytes: 0, // Math.max(0, ...) ensures no negative
      });
    });
  });

  describe("purgeExpiredUnattachedFiles", () => {
    it("should delete files from aggregate using deleteIfExists", async () => {
      const cutoffTime = Date.now() - 24 * 60 * 60 * 1000;
      const mockFiles = [
        {
          _id: "file-1" as Id<"files">,
          user_id: testUserId,
          is_attached: false,
          size: 1024,
          _creationTime: cutoffTime - 1000,
        },
      ];

      const mockQueryBuilder: any = {
        withIndex: jest.fn<any>().mockReturnThis(),
        order: jest.fn<any>().mockReturnThis(),
        take: jest.fn<any>().mockResolvedValue(mockFiles),
      };

      const mockCtx: any = {
        db: {
          query: jest.fn<any>().mockReturnValue(mockQueryBuilder),
          delete: jest.fn<any>(),
        },
        storage: {
          delete: jest.fn<any>(),
        },
        scheduler: {
          runAfter: jest.fn<any>(),
        },
      };

      const { purgeExpiredUnattachedFiles } =
        (await import("../fileStorage")) as any;
      const result = await purgeExpiredUnattachedFiles.handler(mockCtx, {
        cutoffTimeMs: cutoffTime,
      });

      expect(result).toEqual({ deletedCount: 1 });
      expect(mockFileCountAggregate.deleteIfExists).toHaveBeenCalledWith(
        mockCtx,
        mockFiles[0],
      );
      expect(mockCtx.db.delete).toHaveBeenCalledWith("file-1");
    });
  });
});
