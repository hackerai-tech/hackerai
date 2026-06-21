import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

// Mock dependencies
jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    null: jest.fn(() => "null"),
  },
}));
jest.mock("../_generated/api", () => ({
  internal: {
    s3Cleanup: {
      deleteS3ObjectsBatchAction: "deleteS3ObjectsBatchAction",
    },
  },
}));

const mockFileCountAggregate = {
  deleteIfExists: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: mockFileCountAggregate,
}));

describe("userDeletion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("deleteAllUserData", () => {
    it("should delete S3 files using batch deletion", async () => {
      const { deleteAllUserData } = await import("../userDeletion");

      const mockScheduler = {
        runAfter: jest.fn(),
      };

      const mockDb = {
        query: jest.fn(),
        delete: jest.fn(),
      };

      const mockAuth = {
        getUserIdentity: jest.fn().mockResolvedValue({
          subject: "user123",
        }),
      };

      // Mock files with S3 objects and one DB-only file row.
      const mockFiles = [
        {
          _id: "file1",
          s3_key: "users/user123/file1.pdf",
          user_id: "user123",
          name: "file1.pdf",
          media_type: "application/pdf",
          size: 1000,
          file_token_size: 100,
          is_attached: true,
        },
        {
          _id: "file2",
          s3_key: "users/user123/file2.jpg",
          user_id: "user123",
          name: "file2.jpg",
          media_type: "image/jpeg",
          size: 2000,
          file_token_size: 200,
          is_attached: true,
        },
        {
          _id: "file3",
          user_id: "user123",
          name: "file3.txt",
          media_type: "text/plain",
          size: 500,
          file_token_size: 50,
          is_attached: true,
        },
      ];

      // Setup query mocks
      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        collect: jest.fn(),
        first: jest.fn(),
      };

      mockDb.query.mockReturnValue(mockQueryBuilder);

      // Mock query results
      mockQueryBuilder.collect
        .mockResolvedValueOnce([]) // chats
        .mockResolvedValueOnce(mockFiles) // files
        .mockResolvedValueOnce([]) // notes
        .mockResolvedValueOnce([]); // messages

      mockQueryBuilder.first.mockResolvedValue(null); // user_customization

      const mockCtx = {
        auth: mockAuth,
        db: mockDb,
        scheduler: mockScheduler,
      };

      await deleteAllUserData.handler(mockCtx, {});

      // Verify S3 files were collected and scheduled for batch deletion
      expect(mockScheduler.runAfter).toHaveBeenCalledWith(
        0,
        "deleteS3ObjectsBatchAction",
        {
          s3Keys: ["users/user123/file1.pdf", "users/user123/file2.jpg"],
        },
      );

      // Verify all file records were deleted
      expect(mockDb.delete).toHaveBeenCalledWith("file1");
      expect(mockDb.delete).toHaveBeenCalledWith("file2");
      expect(mockDb.delete).toHaveBeenCalledWith("file3");

      // Verify success log
      expect(console.log).toHaveBeenCalledWith(
        "Scheduled deletion of 2 S3 objects for user user123",
      );
    });

    it("should handle file rows without S3 keys", async () => {
      const { deleteAllUserData } = await import("../userDeletion");

      const mockScheduler = {
        runAfter: jest.fn(),
      };

      const mockDb = {
        query: jest.fn(),
        delete: jest.fn(),
      };

      const mockAuth = {
        getUserIdentity: jest.fn().mockResolvedValue({
          subject: "user123",
        }),
      };

      const mockFiles = [
        {
          _id: "file1",
          user_id: "user123",
          name: "file1.txt",
          media_type: "text/plain",
          size: 500,
          file_token_size: 50,
          is_attached: true,
        },
      ];

      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        collect: jest.fn(),
        first: jest.fn(),
      };

      mockDb.query.mockReturnValue(mockQueryBuilder);

      mockQueryBuilder.collect
        .mockResolvedValueOnce([]) // chats
        .mockResolvedValueOnce(mockFiles) // files
        .mockResolvedValueOnce([]) // notes
        .mockResolvedValueOnce([]); // messages

      mockQueryBuilder.first.mockResolvedValue(null);

      const mockCtx = {
        auth: mockAuth,
        db: mockDb,
        scheduler: mockScheduler,
      };

      await deleteAllUserData.handler(mockCtx, {});

      // Verify S3 batch deletion was NOT scheduled (no S3 files)
      expect(mockScheduler.runAfter).not.toHaveBeenCalled();

      // Verify file record was deleted
      expect(mockDb.delete).toHaveBeenCalledWith("file1");
    });

    it("should handle only S3 files", async () => {
      const { deleteAllUserData } = await import("../userDeletion");

      const mockScheduler = {
        runAfter: jest.fn(),
      };

      const mockDb = {
        query: jest.fn(),
        delete: jest.fn(),
      };

      const mockAuth = {
        getUserIdentity: jest.fn().mockResolvedValue({
          subject: "user456",
        }),
      };

      const mockFiles = [
        {
          _id: "file1",
          s3_key: "users/user456/file1.pdf",
          user_id: "user456",
          name: "file1.pdf",
          media_type: "application/pdf",
          size: 1000,
          file_token_size: 100,
          is_attached: true,
        },
      ];

      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        collect: jest.fn(),
        first: jest.fn(),
      };

      mockDb.query.mockReturnValue(mockQueryBuilder);

      mockQueryBuilder.collect
        .mockResolvedValueOnce([]) // chats
        .mockResolvedValueOnce(mockFiles) // files
        .mockResolvedValueOnce([]) // notes
        .mockResolvedValueOnce([]); // messages

      mockQueryBuilder.first.mockResolvedValue(null);

      const mockCtx = {
        auth: mockAuth,
        db: mockDb,
        scheduler: mockScheduler,
      };

      await deleteAllUserData.handler(mockCtx, {});

      // Verify S3 batch deletion was scheduled
      expect(mockScheduler.runAfter).toHaveBeenCalledWith(
        0,
        "deleteS3ObjectsBatchAction",
        { s3Keys: ["users/user456/file1.pdf"] },
      );

      // Verify file record was deleted
      expect(mockDb.delete).toHaveBeenCalledWith("file1");
    });

    it("should not fail user deletion if S3 cleanup scheduling fails", async () => {
      const { deleteAllUserData } = await import("../userDeletion");

      const mockScheduler = {
        runAfter: jest.fn().mockRejectedValue(new Error("Scheduler error")),
      };

      const mockDb = {
        query: jest.fn(),
        delete: jest.fn(),
      };

      const mockAuth = {
        getUserIdentity: jest.fn().mockResolvedValue({
          subject: "user789",
        }),
      };

      const mockFiles = [
        {
          _id: "file1",
          s3_key: "users/user789/file1.pdf",
          user_id: "user789",
          name: "file1.pdf",
          media_type: "application/pdf",
          size: 1000,
          file_token_size: 100,
          is_attached: true,
        },
      ];

      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        collect: jest.fn(),
        first: jest.fn(),
      };

      mockDb.query.mockReturnValue(mockQueryBuilder);

      mockQueryBuilder.collect
        .mockResolvedValueOnce([]) // chats
        .mockResolvedValueOnce(mockFiles) // files
        .mockResolvedValueOnce([]) // notes
        .mockResolvedValueOnce([]); // messages

      mockQueryBuilder.first.mockResolvedValue(null);

      const mockCtx = {
        auth: mockAuth,
        db: mockDb,
        scheduler: mockScheduler,
      };

      // Should not throw even if S3 cleanup scheduling fails
      await expect(
        deleteAllUserData.handler(mockCtx, {}),
      ).resolves.not.toThrow();

      // Verify error was logged
      expect(console.error).toHaveBeenCalledWith(
        "Failed to schedule S3 batch deletion:",
        expect.any(Error),
      );

      // Verify file record was still deleted
      expect(mockDb.delete).toHaveBeenCalledWith("file1");
    });

    it("should handle empty file list", async () => {
      const { deleteAllUserData } = await import("../userDeletion");

      const mockScheduler = {
        runAfter: jest.fn(),
      };

      const mockDb = {
        query: jest.fn(),
        delete: jest.fn(),
      };

      const mockAuth = {
        getUserIdentity: jest.fn().mockResolvedValue({
          subject: "user000",
        }),
      };

      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        collect: jest.fn(),
        first: jest.fn(),
      };

      mockDb.query.mockReturnValue(mockQueryBuilder);

      mockQueryBuilder.collect
        .mockResolvedValueOnce([]) // chats
        .mockResolvedValueOnce([]) // files - empty
        .mockResolvedValueOnce([]) // notes
        .mockResolvedValueOnce([]); // messages

      mockQueryBuilder.first.mockResolvedValue(null);

      const mockCtx = {
        auth: mockAuth,
        db: mockDb,
        scheduler: mockScheduler,
      };

      await deleteAllUserData.handler(mockCtx, {});

      // Verify S3 batch deletion was NOT scheduled (no files)
      expect(mockScheduler.runAfter).not.toHaveBeenCalled();
    });

    it("should delete chat summaries before deleting chats", async () => {
      const { deleteAllUserData } = await import("../userDeletion");

      const mockScheduler = {
        runAfter: jest.fn(),
      };

      const mockChats = [
        {
          _id: "chat-doc-1",
          id: "chat-1",
          user_id: "user123",
          title: "Chat 1",
          update_time: 1000,
          latest_summary_id: "summary-1",
        },
      ];
      const mockSummaries = [
        { _id: "summary-1", chat_id: "chat-1" },
        { _id: "summary-2", chat_id: "chat-1" },
      ];

      const mockDb = {
        query: jest.fn((table: string) => ({
          withIndex: jest.fn().mockReturnValue({
            collect: jest
              .fn()
              .mockResolvedValue(
                table === "chats"
                  ? mockChats
                  : table === "chat_summaries"
                    ? mockSummaries
                    : [],
              ),
            first: jest.fn().mockResolvedValue(null),
          }),
        })),
        delete: jest.fn(),
      };

      const mockAuth = {
        getUserIdentity: jest.fn().mockResolvedValue({
          subject: "user123",
        }),
      };

      const mockCtx = {
        auth: mockAuth,
        db: mockDb,
        scheduler: mockScheduler,
      };

      await deleteAllUserData.handler(mockCtx, {});

      expect(mockDb.query).toHaveBeenCalledWith("chat_summaries");
      expect(mockDb.delete).toHaveBeenCalledWith("summary-1");
      expect(mockDb.delete).toHaveBeenCalledWith("summary-2");
      expect(mockDb.delete).toHaveBeenCalledWith("chat-doc-1");

      const deleteOrder = mockDb.delete.mock.calls.map(([id]) => id);
      expect(deleteOrder.indexOf("summary-1")).toBeLessThan(
        deleteOrder.indexOf("chat-doc-1"),
      );
      expect(deleteOrder.indexOf("summary-2")).toBeLessThan(
        deleteOrder.indexOf("chat-doc-1"),
      );
    });

    it("should throw error if user is not authenticated", async () => {
      const { deleteAllUserData } = await import("../userDeletion");

      const mockAuth = {
        getUserIdentity: jest.fn().mockResolvedValue(null),
      };

      const mockCtx = {
        auth: mockAuth,
      };

      await expect(deleteAllUserData.handler(mockCtx, {})).rejects.toThrow(
        "Unauthorized: User not authenticated",
      );
    });
  });
});
