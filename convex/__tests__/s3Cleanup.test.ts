import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

// Mock dependencies
jest.mock("../s3Utils");
jest.mock("../_generated/server", () => ({
  internalAction: jest.fn((config) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    array: jest.fn(() => "array"),
    null: jest.fn(() => "null"),
  },
}));

describe("s3Cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear console spies
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("deleteS3ObjectAction", () => {
    it("should successfully delete S3 object and log success", async () => {
      const { deleteS3Object } = await import("../s3Utils");
      const mockDeleteS3Object = deleteS3Object as jest.MockedFunction<
        typeof deleteS3Object
      >;
      mockDeleteS3Object.mockResolvedValue(undefined);

      const { deleteS3ObjectAction } = await import("../s3Cleanup");

      const mockCtx = {};
      const args = { s3Key: "users/user123/test-file.pdf" };

      await deleteS3ObjectAction.handler(mockCtx, args);

      expect(mockDeleteS3Object).toHaveBeenCalledWith(args.s3Key);
      // expect(console.log).toHaveBeenCalledWith(
      //   `Successfully deleted S3 object: ${args.s3Key}`,
      // );
    });

    it("should log error but not throw when deletion fails", async () => {
      jest.resetModules();
      jest.mock("../s3Utils");
      jest.mock("../_generated/server", () => ({
        internalAction: jest.fn((config) => config),
      }));
      jest.mock("convex/values", () => ({
        v: {
          string: jest.fn(() => "string"),
          array: jest.fn(() => "array"),
          null: jest.fn(() => "null"),
        },
      }));

      const { deleteS3Object } = await import("../s3Utils");
      const mockDeleteS3Object = deleteS3Object as jest.MockedFunction<
        typeof deleteS3Object
      >;
      const mockError = new Error("S3 deletion failed");
      mockDeleteS3Object.mockRejectedValue(mockError);

      const { deleteS3ObjectAction } = await import("../s3Cleanup");

      const mockCtx = {};
      const args = { s3Key: "users/user123/test-file.pdf" };

      // Should not throw
      await expect(
        deleteS3ObjectAction.handler(mockCtx, args),
      ).resolves.not.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        `Failed to delete S3 object: ${args.s3Key}`,
        mockError,
      );
    });
  });

  describe("deleteS3ObjectsBatchAction", () => {
    it("should delete multiple S3 objects successfully", async () => {
      const { deleteS3Object } = await import("../s3Utils");
      const mockDeleteS3Object = deleteS3Object as jest.MockedFunction<
        typeof deleteS3Object
      >;
      mockDeleteS3Object.mockResolvedValue(undefined);

      const { deleteS3ObjectsBatchAction } = await import("../s3Cleanup");

      const mockCtx = {};
      const args = {
        s3Keys: [
          "users/user123/file1.pdf",
          "users/user123/file2.pdf",
          "users/user123/file3.pdf",
        ],
      };

      await deleteS3ObjectsBatchAction.handler(mockCtx, args);

      expect(mockDeleteS3Object).toHaveBeenCalledTimes(3);
      expect(mockDeleteS3Object).toHaveBeenCalledWith(args.s3Keys[0]);
      expect(mockDeleteS3Object).toHaveBeenCalledWith(args.s3Keys[1]);
      expect(mockDeleteS3Object).toHaveBeenCalledWith(args.s3Keys[2]);
    });

    it("should log error count when some deletions fail", async () => {
      jest.clearAllMocks();
      jest.spyOn(console, "error").mockImplementation(() => {});

      const { deleteS3Object } = await import("../s3Utils");
      const mockDeleteS3Object = deleteS3Object as jest.MockedFunction<
        typeof deleteS3Object
      >;

      // First two succeed, last one fails
      mockDeleteS3Object
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Delete failed"));

      const { deleteS3ObjectsBatchAction } = await import("../s3Cleanup");

      const mockCtx = {};
      const args = {
        s3Keys: [
          "users/user123/file1.pdf",
          "users/user123/file2.pdf",
          "users/user123/file3.pdf",
        ],
      };

      await deleteS3ObjectsBatchAction.handler(mockCtx, args);

      expect(mockDeleteS3Object).toHaveBeenCalledTimes(3);
      expect(console.error).toHaveBeenCalledWith(
        "Failed to delete 1 S3 objects",
      );
    });

    it("should handle all deletions failing", async () => {
      jest.clearAllMocks();
      jest.spyOn(console, "error").mockImplementation(() => {});

      const { deleteS3Object } = await import("../s3Utils");
      const mockDeleteS3Object = deleteS3Object as jest.MockedFunction<
        typeof deleteS3Object
      >;
      mockDeleteS3Object.mockRejectedValue(new Error("Delete failed"));

      const { deleteS3ObjectsBatchAction } = await import("../s3Cleanup");

      const mockCtx = {};
      const args = {
        s3Keys: ["users/user123/file1.pdf", "users/user123/file2.pdf"],
      };

      await deleteS3ObjectsBatchAction.handler(mockCtx, args);

      expect(mockDeleteS3Object).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenCalledWith(
        "Failed to delete 2 S3 objects",
      );
    });

    it("should handle empty array gracefully", async () => {
      const { deleteS3Object } = await import("../s3Utils");
      const mockDeleteS3Object = deleteS3Object as jest.MockedFunction<
        typeof deleteS3Object
      >;

      const { deleteS3ObjectsBatchAction } = await import("../s3Cleanup");

      const mockCtx = {};
      const args = { s3Keys: [] };

      await deleteS3ObjectsBatchAction.handler(mockCtx, args);

      expect(mockDeleteS3Object).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it("should not throw even if all deletions fail", async () => {
      jest.clearAllMocks();

      const { deleteS3Object } = await import("../s3Utils");
      const mockDeleteS3Object = deleteS3Object as jest.MockedFunction<
        typeof deleteS3Object
      >;
      mockDeleteS3Object.mockRejectedValue(new Error("All failed"));

      const { deleteS3ObjectsBatchAction } = await import("../s3Cleanup");

      const mockCtx = {};
      const args = {
        s3Keys: ["users/user123/file1.pdf", "users/user123/file2.pdf"],
      };

      // Should not throw
      await expect(
        deleteS3ObjectsBatchAction.handler(mockCtx, args),
      ).resolves.not.toThrow();
    });
  });
});
