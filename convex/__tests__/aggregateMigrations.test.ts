/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Id } from "../_generated/dataModel";

// Mock dependencies first
jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  MutationCtx: {},
}));
jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    object: jest.fn(() => "object"),
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

// Define mock after jest.mock calls
const mockFileCountAggregate = {
  insertIfDoesNotExist: jest.fn<any>().mockResolvedValue(undefined),
  deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  insert: jest.fn<any>().mockResolvedValue(undefined),
};

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: mockFileCountAggregate,
}));
jest.mock("../aggregateVersions", () => ({
  CURRENT_AGGREGATE_VERSION: 2,
}));

describe("aggregateMigrations", () => {
  const testUserId = "test-user-123";
  const testStateId = "state-id-123" as Id<"user_aggregate_state">;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("ensureUserAggregatesMigrated", () => {
    it("should throw error when user is not authenticated", async () => {
      const mockCtx: any = {
        auth: {
          getUserIdentity: jest.fn<any>().mockResolvedValue(null),
        },
      };

      const { ensureUserAggregatesMigrated } = (await import(
        "../aggregateMigrations"
      )) as any;

      await expect(
        ensureUserAggregatesMigrated.handler(mockCtx, {}),
      ).rejects.toThrow("User not authenticated");
    });

    it("should migrate v0 user to v2 and backfill files", async () => {
      const mockFiles = [
        { _id: "file-1" as Id<"files">, user_id: testUserId, size: 1024 },
        { _id: "file-2" as Id<"files">, user_id: testUserId, size: 2048 },
        { _id: "file-3" as Id<"files">, user_id: testUserId, size: 512 },
      ];

      const mockQueryBuilder: any = {
        withIndex: jest.fn<any>().mockReturnThis(),
        unique: jest.fn<any>().mockResolvedValue(null),
        collect: jest.fn<any>().mockResolvedValue(mockFiles),
      };

      const mockCtx: any = {
        auth: {
          getUserIdentity: jest.fn<any>().mockResolvedValue({
            subject: testUserId,
          }),
        },
        db: {
          query: jest.fn<any>().mockReturnValue(mockQueryBuilder),
          insert: jest.fn<any>().mockResolvedValue(testStateId),
        },
      };

      const { ensureUserAggregatesMigrated } =
        (await import("../aggregateMigrations")) as any;
      const result = await ensureUserAggregatesMigrated.handler(mockCtx, {});

      expect(result).toEqual({ migrated: true });
      // v1 migration: insertIfDoesNotExist for each file
      expect(mockFileCountAggregate.insertIfDoesNotExist).toHaveBeenCalledTimes(
        3,
      );
      // v2 migration: delete + insert for re-backfill
      expect(mockFileCountAggregate.deleteIfExists).toHaveBeenCalledTimes(3);
      expect(mockFileCountAggregate.insert).toHaveBeenCalledTimes(3);
      expect(mockCtx.db.insert).toHaveBeenCalledWith(
        "user_aggregate_state",
        expect.objectContaining({
          user_id: testUserId,
          version: 2,
        }),
      );
    });

    it("should be idempotent when user already at current version", async () => {
      const existingState = {
        _id: testStateId,
        user_id: testUserId,
        version: 2,
        updated_at: Date.now(),
      };

      const mockQueryBuilder: any = {
        withIndex: jest.fn<any>().mockReturnThis(),
        unique: jest.fn<any>().mockResolvedValue(existingState),
      };

      const mockCtx: any = {
        auth: {
          getUserIdentity: jest.fn<any>().mockResolvedValue({
            subject: testUserId,
          }),
        },
        db: {
          query: jest.fn<any>().mockReturnValue(mockQueryBuilder),
          insert: jest.fn<any>(),
          patch: jest.fn<any>(),
        },
      };

      const { ensureUserAggregatesMigrated } =
        (await import("../aggregateMigrations")) as any;
      const result = await ensureUserAggregatesMigrated.handler(mockCtx, {});

      expect(result).toEqual({ migrated: false });
      expect(
        mockFileCountAggregate.insertIfDoesNotExist,
      ).not.toHaveBeenCalled();
      expect(mockFileCountAggregate.deleteIfExists).not.toHaveBeenCalled();
      expect(mockFileCountAggregate.insert).not.toHaveBeenCalled();
      expect(mockCtx.db.insert).not.toHaveBeenCalled();
      expect(mockCtx.db.patch).not.toHaveBeenCalled();
    });

    it("should update existing state record when migrating from v0", async () => {
      const existingState = {
        _id: testStateId,
        user_id: testUserId,
        version: 0,
        updated_at: Date.now() - 10000,
      };

      const mockQueryBuilder: any = {
        withIndex: jest.fn<any>().mockReturnThis(),
        unique: jest.fn<any>().mockResolvedValue(existingState),
        collect: jest.fn<any>().mockResolvedValue([]),
      };

      const mockCtx: any = {
        auth: {
          getUserIdentity: jest.fn<any>().mockResolvedValue({
            subject: testUserId,
          }),
        },
        db: {
          query: jest.fn<any>().mockReturnValue(mockQueryBuilder),
          patch: jest.fn<any>().mockResolvedValue(undefined),
        },
      };

      const { ensureUserAggregatesMigrated } =
        (await import("../aggregateMigrations")) as any;
      const result = await ensureUserAggregatesMigrated.handler(mockCtx, {});

      expect(result).toEqual({ migrated: true });
      expect(mockCtx.db.patch).toHaveBeenCalledWith(
        testStateId,
        expect.objectContaining({
          version: 2,
        }),
      );
    });

    it("should migrate user with no files", async () => {
      const mockQueryBuilder: any = {
        withIndex: jest.fn<any>().mockReturnThis(),
        unique: jest.fn<any>().mockResolvedValue(null),
        collect: jest.fn<any>().mockResolvedValue([]),
      };

      const mockCtx: any = {
        auth: {
          getUserIdentity: jest.fn<any>().mockResolvedValue({
            subject: testUserId,
          }),
        },
        db: {
          query: jest.fn<any>().mockReturnValue(mockQueryBuilder),
          insert: jest.fn<any>().mockResolvedValue(testStateId),
        },
      };

      const { ensureUserAggregatesMigrated } =
        (await import("../aggregateMigrations")) as any;
      const result = await ensureUserAggregatesMigrated.handler(mockCtx, {});

      expect(result).toEqual({ migrated: true });
      expect(
        mockFileCountAggregate.insertIfDoesNotExist,
      ).not.toHaveBeenCalled();
      expect(mockFileCountAggregate.deleteIfExists).not.toHaveBeenCalled();
      expect(mockFileCountAggregate.insert).not.toHaveBeenCalled();
      expect(mockCtx.db.insert).toHaveBeenCalled();
    });

    it("should migrate v1 user to v2 and re-backfill files for size sum", async () => {
      const existingState = {
        _id: testStateId,
        user_id: testUserId,
        version: 1,
        updated_at: Date.now() - 10000,
      };

      const mockFiles = [
        { _id: "file-1" as Id<"files">, user_id: testUserId, size: 1024 },
        { _id: "file-2" as Id<"files">, user_id: testUserId, size: 2048 },
      ];

      const mockQueryBuilder: any = {
        withIndex: jest.fn<any>().mockReturnThis(),
        unique: jest.fn<any>().mockResolvedValue(existingState),
        collect: jest.fn<any>().mockResolvedValue(mockFiles),
      };

      const mockCtx: any = {
        auth: {
          getUserIdentity: jest.fn<any>().mockResolvedValue({
            subject: testUserId,
          }),
        },
        db: {
          query: jest.fn<any>().mockReturnValue(mockQueryBuilder),
          patch: jest.fn<any>().mockResolvedValue(undefined),
        },
      };

      const { ensureUserAggregatesMigrated } =
        (await import("../aggregateMigrations")) as any;
      const result = await ensureUserAggregatesMigrated.handler(mockCtx, {});

      expect(result).toEqual({ migrated: true });
      // v1 already done, so no insertIfDoesNotExist calls
      expect(
        mockFileCountAggregate.insertIfDoesNotExist,
      ).not.toHaveBeenCalled();
      // v2 migration should delete and re-insert each file to capture size sum
      expect(mockFileCountAggregate.deleteIfExists).toHaveBeenCalledTimes(2);
      expect(mockFileCountAggregate.insert).toHaveBeenCalledTimes(2);
      expect(mockFileCountAggregate.deleteIfExists).toHaveBeenCalledWith(
        mockCtx,
        mockFiles[0],
      );
      expect(mockFileCountAggregate.insert).toHaveBeenCalledWith(
        mockCtx,
        mockFiles[0],
      );
      expect(mockCtx.db.patch).toHaveBeenCalledWith(
        testStateId,
        expect.objectContaining({
          version: 2,
        }),
      );
    });
  });
});
