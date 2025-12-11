import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Id } from "../_generated/dataModel";

const mockFileCountAggregate = {
  insertIfDoesNotExist: jest.fn(),
};

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config) => config),
  internalMutation: jest.fn((config) => config),
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
jest.mock("../fileAggregate", () => ({
  fileCountAggregate: mockFileCountAggregate,
}));
jest.mock("../aggregateVersions", () => ({
  CURRENT_AGGREGATE_VERSION: 1,
}));

describe("aggregateMigrations", () => {
  const testUserId = "test-user-123";
  const testStateId = "state-id-123" as Id<"user_aggregate_state">;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("migrateUserAggregates", () => {
    it("should migrate v0 user to v1 and backfill files", async () => {
      const mockFiles = [
        { _id: "file-1" as Id<"files">, user_id: testUserId },
        { _id: "file-2" as Id<"files">, user_id: testUserId },
        { _id: "file-3" as Id<"files">, user_id: testUserId },
      ];

      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        unique: jest.fn().mockResolvedValue(null),
        collect: jest.fn().mockResolvedValue(mockFiles),
      };

      const mockCtx = {
        db: {
          query: jest.fn().mockReturnValue(mockQueryBuilder),
          insert: jest.fn().mockResolvedValue(testStateId),
        },
      };

      mockFileCountAggregate.insertIfDoesNotExist.mockResolvedValue(undefined);

      const { migrateUserAggregates } = await import("../aggregateMigrations");
      const result = await migrateUserAggregates.handler(mockCtx, {
        userId: testUserId,
      });

      expect(result).toEqual({
        previousVersion: 0,
        newVersion: 1,
        migrated: true,
      });
      expect(mockFileCountAggregate.insertIfDoesNotExist).toHaveBeenCalledTimes(
        3,
      );
      expect(mockCtx.db.insert).toHaveBeenCalledWith(
        "user_aggregate_state",
        expect.objectContaining({
          user_id: testUserId,
          version: 1,
        }),
      );
    });

    it("should be idempotent when user already at current version", async () => {
      const existingState = {
        _id: testStateId,
        user_id: testUserId,
        version: 1,
        updated_at: Date.now(),
      };

      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        unique: jest.fn().mockResolvedValue(existingState),
      };

      const mockCtx = {
        db: {
          query: jest.fn().mockReturnValue(mockQueryBuilder),
          insert: jest.fn(),
          patch: jest.fn(),
        },
      };

      const { migrateUserAggregates } = await import("../aggregateMigrations");
      const result = await migrateUserAggregates.handler(mockCtx, {
        userId: testUserId,
      });

      expect(result).toEqual({
        previousVersion: 1,
        newVersion: 1,
        migrated: false,
      });
      expect(mockFileCountAggregate.insertIfDoesNotExist).not.toHaveBeenCalled();
      expect(mockCtx.db.insert).not.toHaveBeenCalled();
      expect(mockCtx.db.patch).not.toHaveBeenCalled();
    });

    it("should update existing state record when migrating", async () => {
      const existingState = {
        _id: testStateId,
        user_id: testUserId,
        version: 0,
        updated_at: Date.now() - 10000,
      };

      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        unique: jest.fn().mockResolvedValue(existingState),
        collect: jest.fn().mockResolvedValue([]),
      };

      const mockCtx = {
        db: {
          query: jest.fn().mockReturnValue(mockQueryBuilder),
          patch: jest.fn().mockResolvedValue(undefined),
        },
      };

      const { migrateUserAggregates } = await import("../aggregateMigrations");
      const result = await migrateUserAggregates.handler(mockCtx, {
        userId: testUserId,
      });

      expect(result.migrated).toBe(true);
      expect(mockCtx.db.patch).toHaveBeenCalledWith(
        testStateId,
        expect.objectContaining({
          version: 1,
        }),
      );
    });

    it("should migrate user with no files", async () => {
      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        unique: jest.fn().mockResolvedValue(null),
        collect: jest.fn().mockResolvedValue([]),
      };

      const mockCtx = {
        db: {
          query: jest.fn().mockReturnValue(mockQueryBuilder),
          insert: jest.fn().mockResolvedValue(testStateId),
        },
      };

      const { migrateUserAggregates } = await import("../aggregateMigrations");
      const result = await migrateUserAggregates.handler(mockCtx, {
        userId: testUserId,
      });

      expect(result).toEqual({
        previousVersion: 0,
        newVersion: 1,
        migrated: true,
      });
      expect(mockFileCountAggregate.insertIfDoesNotExist).not.toHaveBeenCalled();
      expect(mockCtx.db.insert).toHaveBeenCalled();
    });
  });

  describe("ensureUserAggregatesMigrated", () => {
    it("should throw error when user is not authenticated", async () => {
      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue(null),
        },
      };

      const { ensureUserAggregatesMigrated } = await import(
        "../aggregateMigrations"
      );

      await expect(
        ensureUserAggregatesMigrated.handler(mockCtx, {}),
      ).rejects.toThrow("User not authenticated");
    });

    it("should call runMigration with authenticated user subject", async () => {
      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        unique: jest.fn().mockResolvedValue(null),
        collect: jest.fn().mockResolvedValue([]),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: testUserId,
          }),
        },
        db: {
          query: jest.fn().mockReturnValue(mockQueryBuilder),
          insert: jest.fn().mockResolvedValue(testStateId),
        },
      };

      const { ensureUserAggregatesMigrated } = await import(
        "../aggregateMigrations"
      );
      const result = await ensureUserAggregatesMigrated.handler(mockCtx, {});

      expect(result).toEqual({ migrated: true });
    });

    it("should return migrated: false when already migrated", async () => {
      const existingState = {
        _id: testStateId,
        user_id: testUserId,
        version: 1,
        updated_at: Date.now(),
      };

      const mockQueryBuilder = {
        withIndex: jest.fn().mockReturnThis(),
        unique: jest.fn().mockResolvedValue(existingState),
      };

      const mockCtx = {
        auth: {
          getUserIdentity: jest.fn().mockResolvedValue({
            subject: testUserId,
          }),
        },
        db: {
          query: jest.fn().mockReturnValue(mockQueryBuilder),
        },
      };

      const { ensureUserAggregatesMigrated } = await import(
        "../aggregateMigrations"
      );
      const result = await ensureUserAggregatesMigrated.handler(mockCtx, {});

      expect(result).toEqual({ migrated: false });
    });
  });
});
