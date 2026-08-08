import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  internalQuery: jest.fn((config) => config),
  mutation: jest.fn((config) => config),
}));

function createCtx(existing: unknown) {
  const unique = jest.fn().mockResolvedValue(existing);
  const withIndex = jest.fn((_name, build) => {
    const query = { eq: jest.fn().mockReturnThis() };
    build(query);
    return { unique };
  });
  const insert = jest.fn().mockResolvedValue("fence_123");

  return {
    ctx: {
      db: {
        query: jest.fn(() => ({ withIndex })),
        insert,
      },
    },
    insert,
  };
}

describe("account deletion fences", () => {
  beforeEach(() => {
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
  });

  it("creates a durable user fence", async () => {
    const { startByService } = await import("../accountDeletionFences");
    const { ctx, insert } = createCtx(null);

    await expect(
      startByService.handler(ctx as any, {
        serviceKey: "service_key",
        userId: "user_123",
        nowMs: 42,
      }),
    ).resolves.toBeNull();
    expect(insert).toHaveBeenCalledWith("account_deletion_fences", {
      user_id: "user_123",
      deletion_started_at: 42,
    });
  });

  it("keeps the first fence when account deletion is retried", async () => {
    const { startByService } = await import("../accountDeletionFences");
    const { ctx, insert } = createCtx({ _id: "fence_123" });

    await expect(
      startByService.handler(ctx as any, {
        serviceKey: "service_key",
        userId: "user_123",
      }),
    ).resolves.toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });

  it("reports whether a user is fenced", async () => {
    const { isSet } = await import("../accountDeletionFences");
    const existing = createCtx({ _id: "fence_123" });
    const missing = createCtx(null);

    await expect(
      isSet.handler(existing.ctx as any, { userId: "user_123" }),
    ).resolves.toBe(true);
    await expect(
      isSet.handler(missing.ctx as any, { userId: "user_456" }),
    ).resolves.toBe(false);
  });
});
