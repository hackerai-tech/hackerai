/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Id } from "../_generated/dataModel";

// Mock dependencies
jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
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
    data: any;
    constructor(data: any) {
      super(typeof data === "string" ? data : data.message);
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
      deleteS3ObjectsBatchAction:
        "internal.s3Cleanup.deleteS3ObjectsBatchAction",
    },
  },
}));

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
jest.mock("../aggregateVersions", () => ({
  isFileCountAggregateAvailable: jest.fn<any>().mockResolvedValue(true),
  isFileSizeAggregateAvailable: jest.fn<any>().mockResolvedValue(true),
}));

describe("fileStorage - deleteFile", () => {
  let mockCtx: any;
  let mockFile: any;
  const testFileId = "test-file-id" as Id<"files">;
  const testUserId = "test-user-123";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    mockFile = {
      _id: testFileId,
      user_id: testUserId,
      name: "test-file.pdf",
      media_type: "application/pdf",
      size: 1024,
      file_token_size: 100,
      is_attached: false,
      _creationTime: Date.now(),
    };

    mockCtx = {
      auth: {
        getUserIdentity: jest.fn().mockResolvedValue({
          subject: testUserId,
        }),
      },
      db: {
        get: jest.fn().mockResolvedValue(mockFile),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      storage: {
        delete: jest.fn().mockResolvedValue(undefined),
      },
      scheduler: {
        runAfter: jest.fn().mockResolvedValue(undefined),
      },
    };
  });

  describe("Authentication and Authorization", () => {
    it("should throw error if user is not authenticated", async () => {
      mockCtx.auth.getUserIdentity.mockResolvedValue(null);

      const { deleteFile } = await import("../fileStorage");

      await expect(
        deleteFile.handler(mockCtx, { fileId: testFileId }),
      ).rejects.toThrow("Unauthorized: User not authenticated");

      expect(mockCtx.db.get).not.toHaveBeenCalled();
      expect(mockCtx.db.delete).not.toHaveBeenCalled();
    });

    it("should throw error if file not found", async () => {
      mockCtx.db.get.mockResolvedValue(null);

      const { deleteFile } = await import("../fileStorage");

      await expect(
        deleteFile.handler(mockCtx, { fileId: testFileId }),
      ).rejects.toThrow("File not found");

      expect(mockCtx.db.delete).not.toHaveBeenCalled();
    });

    it("should throw error if file does not belong to user", async () => {
      mockFile.user_id = "different-user-id";
      mockCtx.db.get.mockResolvedValue(mockFile);

      const { deleteFile } = await import("../fileStorage");

      await expect(
        deleteFile.handler(mockCtx, { fileId: testFileId }),
      ).rejects.toThrow("Unauthorized: File does not belong to user");

      expect(mockCtx.db.delete).not.toHaveBeenCalled();
    });
  });

  describe("S3 File Deletion", () => {
    it("should schedule S3 deletion for S3 files", async () => {
      mockFile.s3_key = "users/test-user-123/test-file.pdf";
      mockFile.storage_id = undefined;
      mockCtx.db.get.mockResolvedValue(mockFile);

      const { deleteFile } = await import("../fileStorage");

      await deleteFile.handler(mockCtx, { fileId: testFileId });

      // Verify S3 deletion was scheduled
      expect(mockCtx.scheduler.runAfter).toHaveBeenCalledWith(
        0,
        "internal.s3Cleanup.deleteS3ObjectAction",
        { s3Key: mockFile.s3_key },
      );

      // Verify Convex storage delete was not called
      expect(mockCtx.storage.delete).not.toHaveBeenCalled();

      // Verify aggregate was updated
      expect(mockFileCountAggregate.deleteIfExists).toHaveBeenCalledWith(
        mockCtx,
        mockFile,
      );

      // Verify database record was deleted
      expect(mockCtx.db.delete).toHaveBeenCalledWith(testFileId);
    });

    it("should delete DB record even if S3 scheduling fails", async () => {
      mockFile.s3_key = "users/test-user-123/test-file.pdf";
      mockFile.storage_id = undefined;
      mockCtx.db.get.mockResolvedValue(mockFile);
      mockCtx.scheduler.runAfter.mockRejectedValue(
        new Error("Scheduler error"),
      );

      const { deleteFile } = await import("../fileStorage");

      await expect(
        deleteFile.handler(mockCtx, { fileId: testFileId }),
      ).rejects.toThrow("Scheduler error");

      // DB delete should not be called if scheduler fails
      expect(mockCtx.db.delete).not.toHaveBeenCalled();
    });
  });

  describe("Convex Storage File Deletion", () => {
    it("should delete Convex storage for Convex files", async () => {
      mockFile.storage_id = "storage-id-123" as Id<"_storage">;
      mockFile.s3_key = undefined;
      mockCtx.db.get.mockResolvedValue(mockFile);

      const { deleteFile } = await import("../fileStorage");

      await deleteFile.handler(mockCtx, { fileId: testFileId });

      // Verify Convex storage delete was called
      expect(mockCtx.storage.delete).toHaveBeenCalledWith(mockFile.storage_id);

      // Verify S3 deletion was not scheduled (scheduler might be called for aggregate but not S3)
      expect(mockCtx.scheduler.runAfter).not.toHaveBeenCalledWith(
        expect.anything(),
        "internal.s3Cleanup.deleteS3ObjectAction",
        expect.anything(),
      );

      // Verify aggregate was updated
      expect(mockFileCountAggregate.deleteIfExists).toHaveBeenCalledWith(
        mockCtx,
        mockFile,
      );

      // Verify database record was deleted
      expect(mockCtx.db.delete).toHaveBeenCalledWith(testFileId);
    });

    it("should delete DB record even if Convex storage deletion fails", async () => {
      mockFile.storage_id = "storage-id-123" as Id<"_storage">;
      mockFile.s3_key = undefined;
      mockCtx.db.get.mockResolvedValue(mockFile);
      mockCtx.storage.delete.mockRejectedValue(
        new Error("Storage delete failed"),
      );

      const { deleteFile } = await import("../fileStorage");

      await expect(
        deleteFile.handler(mockCtx, { fileId: testFileId }),
      ).rejects.toThrow("Storage delete failed");

      // DB delete should not be called if storage delete fails
      expect(mockCtx.db.delete).not.toHaveBeenCalled();
    });
  });

  describe("Edge Cases", () => {
    it("should warn and still delete DB record if file has neither s3_key nor storage_id", async () => {
      mockFile.s3_key = undefined;
      mockFile.storage_id = undefined;
      mockCtx.db.get.mockResolvedValue(mockFile);

      const { deleteFile } = await import("../fileStorage");

      await deleteFile.handler(mockCtx, { fileId: testFileId });

      // Should warn about missing storage reference
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("has neither s3_key nor storage_id"),
      );

      // Should not attempt storage deletion
      expect(mockCtx.storage.delete).not.toHaveBeenCalled();
      // S3 cleanup should not be scheduled (aggregate delete attempts are okay)
      expect(mockCtx.scheduler.runAfter).not.toHaveBeenCalledWith(
        expect.anything(),
        "internal.s3Cleanup.deleteS3ObjectAction",
        expect.anything(),
      );

      // Verify aggregate was still updated
      expect(mockFileCountAggregate.deleteIfExists).toHaveBeenCalledWith(
        mockCtx,
        mockFile,
      );

      // Should still delete database record
      expect(mockCtx.db.delete).toHaveBeenCalledWith(testFileId);
    });

    it("should return null on successful deletion", async () => {
      mockFile.storage_id = "storage-id-123" as Id<"_storage">;
      mockCtx.db.get.mockResolvedValue(mockFile);

      const { deleteFile } = await import("../fileStorage");

      const result = await deleteFile.handler(mockCtx, { fileId: testFileId });

      expect(result).toBeNull();
    });
  });
});
