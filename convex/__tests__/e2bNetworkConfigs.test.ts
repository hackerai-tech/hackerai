jest.mock("../_generated/server", () => ({
  internalMutation: jest.fn((config) => config),
  internalQuery: jest.fn((config) => config),
}));

import {
  releaseMigrationLease,
  tryAcquireMigrationLease,
} from "../e2bNetworkConfigs";

function createCtx(
  existing: {
    _id: string;
    user_id: string;
    lease_id: string;
    expires_at: number;
  } | null,
) {
  const unique = jest.fn(async () => existing);
  return {
    ctx: {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn(() => ({ unique })),
        })),
        patch: jest.fn(async () => undefined),
        insert: jest.fn(async () => "new-lease-id"),
        delete: jest.fn(async () => undefined),
      },
    },
    unique,
  };
}

describe("E2B network migration leases", () => {
  it("rejects acquisition while an unexpired lease is held", async () => {
    const { ctx } = createCtx({
      _id: "lease-doc",
      user_id: "user-1",
      lease_id: "lease-existing",
      expires_at: 2_000,
    });

    await expect(
      tryAcquireMigrationLease.handler(ctx as any, {
        userId: "user-1",
        leaseId: "lease-new",
        now: 1_000,
        expiresAt: 11_000,
      }),
    ).resolves.toBe(false);
    expect(ctx.db.patch).not.toHaveBeenCalled();
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it("atomically takes over an expired lease", async () => {
    const { ctx } = createCtx({
      _id: "lease-doc",
      user_id: "user-1",
      lease_id: "lease-expired",
      expires_at: 999,
    });

    await expect(
      tryAcquireMigrationLease.handler(ctx as any, {
        userId: "user-1",
        leaseId: "lease-new",
        now: 1_000,
        expiresAt: 11_000,
      }),
    ).resolves.toBe(true);
    expect(ctx.db.patch).toHaveBeenCalledWith("lease-doc", {
      lease_id: "lease-new",
      expires_at: 11_000,
    });
  });

  it("only lets the current holder release a lease", async () => {
    const existing = {
      _id: "lease-doc",
      user_id: "user-1",
      lease_id: "lease-current",
      expires_at: 2_000,
    };
    const wrongHolder = createCtx(existing);
    await releaseMigrationLease.handler(wrongHolder.ctx as any, {
      userId: "user-1",
      leaseId: "lease-stale",
    });
    expect(wrongHolder.ctx.db.delete).not.toHaveBeenCalled();

    const currentHolder = createCtx(existing);
    await releaseMigrationLease.handler(currentHolder.ctx as any, {
      userId: "user-1",
      leaseId: "lease-current",
    });
    expect(currentHolder.ctx.db.delete).toHaveBeenCalledWith("lease-doc");
  });
});
