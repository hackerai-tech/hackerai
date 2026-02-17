/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Id } from "../_generated/dataModel";

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

const mockIsFileSizeAggregateAvailable = jest.fn<any>().mockResolvedValue(true);

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: mockFileCountAggregate,
}));
jest.mock("../aggregateVersions", () => ({
  isFileSizeAggregateAvailable: mockIsFileSizeAggregateAvailable,
}));

describe("fileStorage - Aggregate Integration", () => {
  const testUserId = "test-user-123";
  const testFileId = "test-file-id" as Id<"files">;
  // 10 GB in bytes
  const MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    // Reset mocks to default values
    mockFileCountAggregate.sum.mockResolvedValue(0);
    mockIsFileSizeAggregateAvailable.mockResolvedValue(true);
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

      const mockCtx: any = {
        db: {
          insert: jest.fn<any>().mockResolvedValue(testFileId),
          get: jest.fn<any>().mockResolvedValue(mockFile),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;
      const result = await saveFileToDb.handler(mockCtx, {
        userId: testUserId,
        name: "test.pdf",
        mediaType: "application/pdf",
        size: 1024,
        fileTokenSize: 100,
      });

      expect(result).toBe(testFileId);
      expect(mockCtx.db.insert).toHaveBeenCalledWith(
        "files",
        expect.objectContaining({
          user_id: testUserId,
          name: "test.pdf",
          is_attached: false,
        }),
      );
      expect(mockFileCountAggregate.insertIfDoesNotExist).toHaveBeenCalledWith(
        mockCtx,
        mockFile,
      );
    });

    it("should check storage limit before saving file", async () => {
      // User has 9 GB used
      const usedBytes = 9 * 1024 * 1024 * 1024;
      mockFileCountAggregate.sum.mockResolvedValue(usedBytes);

      const mockCtx: any = {
        db: {
          insert: jest.fn<any>().mockResolvedValue(testFileId),
          get: jest.fn<any>().mockResolvedValue(null),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;

      // Try to upload a 500 MB file (should succeed, under limit)
      const smallFileSize = 500 * 1024 * 1024;
      await saveFileToDb.handler(mockCtx, {
        userId: testUserId,
        name: "small.pdf",
        mediaType: "application/pdf",
        size: smallFileSize,
        fileTokenSize: 100,
      });

      expect(mockCtx.db.insert).toHaveBeenCalled();
    });

    it("should throw error when storage limit exceeded", async () => {
      // User has 9.5 GB used
      const usedBytes = 9.5 * 1024 * 1024 * 1024;
      mockFileCountAggregate.sum.mockResolvedValue(usedBytes);

      const mockCtx: any = {
        db: {
          insert: jest.fn<any>().mockResolvedValue(testFileId),
          get: jest.fn<any>().mockResolvedValue(null),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;

      // Try to upload a 1 GB file (should fail, exceeds limit)
      const largeFileSize = 1 * 1024 * 1024 * 1024;
      await expect(
        saveFileToDb.handler(mockCtx, {
          userId: testUserId,
          name: "large.pdf",
          mediaType: "application/pdf",
          size: largeFileSize,
          fileTokenSize: 100,
        }),
      ).rejects.toThrow("Storage limit exceeded");

      expect(mockCtx.db.insert).not.toHaveBeenCalled();
    });

    it("should skip storage check when aggregate not available", async () => {
      mockIsFileSizeAggregateAvailable.mockResolvedValue(false);

      const mockFile = {
        _id: testFileId,
        user_id: testUserId,
        name: "test.pdf",
        media_type: "application/pdf",
        size: 1024,
        file_token_size: 100,
        is_attached: false,
      };

      const mockCtx: any = {
        db: {
          insert: jest.fn<any>().mockResolvedValue(testFileId),
          get: jest.fn<any>().mockResolvedValue(mockFile),
        },
      };

      const { saveFileToDb } = (await import("../fileStorage")) as any;
      await saveFileToDb.handler(mockCtx, {
        userId: testUserId,
        name: "test.pdf",
        mediaType: "application/pdf",
        size: 1024,
        fileTokenSize: 100,
      });

      // Should not check sum when aggregate not available
      expect(mockFileCountAggregate.sum).not.toHaveBeenCalled();
      expect(mockCtx.db.insert).toHaveBeenCalled();
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

    it("should return null when aggregate is not available", async () => {
      mockIsFileSizeAggregateAvailable.mockResolvedValue(false);

      const mockCtx: any = {};

      const { getUserStorageUsage } = (await import("../fileStorage")) as any;
      const result = await getUserStorageUsage.handler(mockCtx, {
        userId: testUserId,
      });

      expect(result).toBeNull();
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
