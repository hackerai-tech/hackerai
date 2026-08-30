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
    optional: jest.fn(() => "optional"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
    object: jest.fn(() => "object"),
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
          optional: jest.fn(() => "optional"),
          union: jest.fn(() => "union"),
          literal: jest.fn(() => "literal"),
          object: jest.fn(() => "object"),
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

      expect(console.error).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(
        (console.error as jest.Mock).mock.calls[0][0] as string,
      );
      expect(logged).toMatchObject({
        level: "error",
        event: "s3_object_delete_failed",
        s3Key: args.s3Key,
        error: { name: "Error", message: mockError.message },
      });
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

    it("deletes regional objects from their persisted location", async () => {
      const { deleteS3Object, getStoredS3Location } =
        await import("../s3Utils");
      const storageLocation = {
        region: "us-west-2" as const,
        bucket: "test-west-bucket",
      };
      (
        getStoredS3Location as jest.MockedFunction<typeof getStoredS3Location>
      ).mockReturnValue(storageLocation);
      const { deleteS3ObjectsBatchAction } = await import("../s3Cleanup");

      await deleteS3ObjectsBatchAction.handler(
        {},
        {
          s3Objects: [
            {
              s3Key: "users/user123/regional.pdf",
              s3Region: "us-west-2",
              s3Bucket: "test-west-bucket",
            },
          ],
        },
      );

      expect(getStoredS3Location).toHaveBeenCalledWith(
        "us-west-2",
        "test-west-bucket",
      );
      expect(deleteS3Object).toHaveBeenCalledWith(
        "users/user123/regional.pdf",
        storageLocation,
      );
    });

    it("continues after malformed location metadata fails synchronously", async () => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      const { deleteS3Object, getStoredS3Location } =
        await import("../s3Utils");
      (
        getStoredS3Location as jest.MockedFunction<typeof getStoredS3Location>
      ).mockImplementation((region, bucket) => {
        if (region && !bucket) {
          throw new Error("Incomplete S3 storage location metadata");
        }
        return undefined;
      });
      const { deleteS3ObjectsBatchAction } = await import("../s3Cleanup");

      await expect(
        deleteS3ObjectsBatchAction.handler(
          {},
          {
            s3Objects: [
              {
                s3Key: "users/user123/malformed.pdf",
                s3Region: "us-west-2",
              },
              { s3Key: "users/user123/legacy.pdf" },
            ],
          },
        ),
      ).resolves.toBeNull();

      expect(deleteS3Object).toHaveBeenCalledTimes(1);
      expect(deleteS3Object).toHaveBeenCalledWith("users/user123/legacy.pdf");
      const logged = JSON.parse(
        (console.error as jest.Mock).mock.calls[0][0] as string,
      );
      expect(logged).toMatchObject({
        event: "s3_object_batch_delete_failed",
        failedCount: 1,
        failedKeys: ["users/user123/malformed.pdf"],
      });
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
      const logged = JSON.parse(
        (console.error as jest.Mock).mock.calls[0][0] as string,
      );
      expect(logged).toMatchObject({
        level: "error",
        event: "s3_object_batch_delete_failed",
        totalCount: 3,
        failedCount: 1,
        failedKeys: ["users/user123/file3.pdf"],
      });
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
      const logged = JSON.parse(
        (console.error as jest.Mock).mock.calls[0][0] as string,
      );
      expect(logged).toMatchObject({
        level: "error",
        event: "s3_object_batch_delete_failed",
        totalCount: 2,
        failedCount: 2,
      });
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
  });
});
