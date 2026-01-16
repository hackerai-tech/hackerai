import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Id } from "../_generated/dataModel";

const mockFileCountAggregate = {
  count: jest.fn(),
  insert: jest.fn(),
  insertIfDoesNotExist: jest.fn(),
  delete: jest.fn(),
  deleteIfExists: jest.fn(),
};

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config) => config),
  internalMutation: jest.fn((config) => config),
  query: jest.fn((config) => config),
  internalQuery: jest.fn((config) => config),
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
jest.mock("../chats", () => ({
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
jest.mock("../fileAggregate", () => ({
  fileCountAggregate: mockFileCountAggregate,
}));

describe("fileStorage - Aggregate Integration", () => {
  const testUserId = "test-user-123";
  const testFileId = "test-file-id" as Id<"files">;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
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

      mockFileCountAggregate.insertIfDoesNotExist.mockResolvedValue(undefined);

      const mockCtx = {
        db: {
          insert: jest.fn().mockResolvedValue(testFileId),
          get: jest.fn().mockResolvedValue(mockFile),
        },
      };

      const { saveFileToDb } = await import("../fileStorage");
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
  });

  describe("purgeExpiredUnattachedFiles", () => {
    it("should delete files from aggregate using deleteIfExists", async () => {
      const cutoffTime = Date.now() - 24 * 60 * 60 * 1000;
      const mockFiles = [
        {
          _id: "file-1" as Id<"files">,
          user_id: testUserId,
          is_attached: false,
          _creationTime: cutoffTime - 1000,
        },
      ];

      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        take: jest.fn().mockResolvedValue(mockFiles),
      };

      const mockCtx = {
        db: {
          query: jest.fn().mockReturnValue(mockQueryBuilder),
          delete: jest.fn(),
        },
        storage: {
          delete: jest.fn(),
        },
        scheduler: {
          runAfter: jest.fn(),
        },
      };

      mockFileCountAggregate.deleteIfExists.mockResolvedValue(undefined);

      const { purgeExpiredUnattachedFiles } = await import("../fileStorage");
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
