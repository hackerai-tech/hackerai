import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { getFunctionName } from "convex/server";

jest.mock("../lib/serviceFunctions", () => ({
  internalMutation: (definition: unknown) => definition,
  query: (definition: unknown) => definition,
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "test-key") throw new Error("Unauthorized");
  },
}));

const {
  begin,
  finish,
  linkAutoReload,
  getForBackend,
} = require("../settlementReceipts");
const { recordWalletDebit } = require("../lib/settlementReceipts");
const { runWalletSettlement } = require("../lib/settlementAction");

const identity = {
  operation_id: "wallet-v1:synthetic:step:1",
  user_id: "synthetic-user",
  usage_settlement_id: "synthetic",
  amount_points: 20,
};
const debit = (balance: number, success = true) => ({
  success,
  newBalancePoints: balance,
  newBalanceDollars: balance * 0.00015,
  insufficientFunds: !success,
  monthlyCapExceeded: false,
});
const result = {
  success: true,
  newBalanceDollars: 0.012,
  insufficientFunds: false,
  monthlyCapExceeded: false,
  autoReloadTriggered: false,
};

function database() {
  const tables = new Map<string, any[]>([
    [
      "extra_usage",
      [{ _id: "wallet", user_id: identity.user_id, balance_points: 100 }],
    ],
  ]);
  const db = {
    query: (table: string) => ({
      withIndex: (_name: string, build: any) => {
        const eq: Record<string, unknown> = {};
        const chain = {
          eq: (k: string, v: unknown) => {
            eq[k] = v;
            return chain;
          },
        };
        build(chain);
        const matches = () =>
          (tables.get(table) ?? []).filter((row) =>
            Object.entries(eq).every(([k, v]) => row[k] === v),
          );
        return {
          unique: async () => {
            const rows = matches();
            if (rows.length > 1) throw Error("duplicate");
            return rows[0] ?? null;
          },
          take: async (n: number) => matches().slice(0, n),
          first: async () => matches()[0] ?? null,
        };
      },
    }),
    insert: async (table: string, value: any) => {
      const rows = tables.get(table) ?? [];
      const row = { ...value, _id: `${table}:${rows.length}` };
      rows.push(row);
      tables.set(table, rows);
      return row._id;
    },
    patch: async (id: string, patch: any) => {
      const row = [...tables.values()].flat().find((x) => x._id === id);
      if (!row) throw Error("missing");
      Object.assign(row, patch);
    },
  };
  return { tables, db };
}

function applyDebit(ctx: any, balance: number) {
  ctx.tables.get("extra_usage")[0].balance_points = balance;
  return debit(balance);
}

async function start(ctx: any, input = identity) {
  return (begin as any).handler(ctx, input);
}
async function read(ctx: any, input = identity) {
  return (getForBackend as any).handler(ctx, {
    ...input,
    serviceKey: "test-key",
  });
}

describe("durable wallet settlement receipts", () => {
  let ctx: any;
  beforeEach(() => {
    ctx = database();
  });
  it("stores a debit with its before/after balance and returns it after lost acknowledgement", async () => {
    await start(ctx);
    const execute = jest.fn(async () => applyDebit(ctx, 80));
    await recordWalletDebit(ctx, identity, 0, execute);
    // Simulated HTTP loss after transaction commit: repeat returns the saved result.
    expect(await recordWalletDebit(ctx, identity, 0, execute)).toEqual(
      debit(80),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await read(ctx)).debits).toEqual([
      expect.objectContaining({
        outcome: "applied",
        previous_balance_points: 100,
        new_balance_points: 80,
        sequence: 0,
      }),
    ]);
    expect((await read(ctx)).status).toBe("pending");
  });
  it("does not apply a second successful attempt, even with a different sequence", async () => {
    await start(ctx);
    await recordWalletDebit(ctx, identity, 0, async () => applyDebit(ctx, 80));
    const execute = jest.fn(async () => applyDebit(ctx, 60));
    expect(await recordWalletDebit(ctx, identity, 1, execute)).toEqual(
      debit(80),
    );
    expect(execute).not.toHaveBeenCalled();
    expect((await read(ctx)).debits).toHaveLength(1);
  });
  it("retains a known no-debit result and gives a funded retry its own receipt", async () => {
    await start(ctx);
    await recordWalletDebit(ctx, identity, 0, async () => debit(0, false));
    expect(
      await recordWalletDebit(ctx, identity, 0, async () => debit(100)),
    ).toEqual(debit(0, false));
    await recordWalletDebit(ctx, identity, 1, async () => applyDebit(ctx, 80));
    expect((await read(ctx)).debits.map((x: any) => x.outcome)).toEqual([
      "not_applied",
      "applied",
    ]);
  });
  it.each([
    "amount_points",
    "user_id",
    "organization_id",
    "usage_settlement_id",
  ])("rejects reuse with different %s", async (field) => {
    await start(ctx);
    const other = {
      ...identity,
      [field]: field === "amount_points" ? 21 : "other",
    };
    await expect(start(ctx, other)).rejects.toThrow("input mismatch");
    await expect(
      recordWalletDebit(ctx, other, 0, async () => applyDebit(ctx, 80)),
    ).rejects.toThrow("input mismatch");
    if (field === "user_id" || field === "organization_id") {
      await expect(read(ctx, other)).rejects.toThrow("scope mismatch");
    }
  });
  it("allows two distinct steps in one settlement", async () => {
    const second = { ...identity, operation_id: "wallet-v1:synthetic:step:2" };
    await start(ctx);
    await start(ctx, second);
    await recordWalletDebit(ctx, identity, 0, async () => applyDebit(ctx, 80));
    await recordWalletDebit(ctx, second, 0, async () => applyDebit(ctx, 60));
    expect(ctx.tables.get("usage_settlement_debits")).toHaveLength(2);
  });
  it("keeps pre-commit failures unknown and never invents a no-debit receipt", async () => {
    await start(ctx);
    await expect(
      recordWalletDebit(ctx, identity, 0, async () => {
        throw Error("failure");
      }),
    ).rejects.toThrow("failure");
    expect(await read(ctx)).toMatchObject({ status: "pending", debits: [] });
  });
  it("does not backfill legacy operations or treat missing receipts as no debit", async () => {
    expect(await read(ctx)).toBeNull();
    await recordWalletDebit(ctx, undefined, undefined, async () =>
      applyDebit(ctx, 80),
    );
    expect(ctx.tables.get("usage_settlement_operations")).toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity, 1.5])(
    "rejects invalid receipted amounts %s",
    async (amount) => {
      await expect(
        start(ctx, { ...identity, amount_points: amount }),
      ).rejects.toThrow("Invalid settlement");
      expect(ctx.tables.get("usage_settlement_operations")).toBeUndefined();
    },
  );
  it("retains the Stripe reload identity while a settlement is still unknown", async () => {
    await start(ctx);
    await (linkAutoReload as any).handler(ctx, {
      ...identity,
      auto_reload_operation_id: "reload-1",
    });
    await (linkAutoReload as any).handler(ctx, {
      ...identity,
      auto_reload_operation_id: "reload-1",
    });
    expect((await read(ctx)).auto_reload_operation_ids).toEqual(["reload-1"]);
    await expect(
      (linkAutoReload as any).handler(ctx, {
        ...identity,
        user_id: "other",
        auto_reload_operation_id: "reload-2",
      }),
    ).rejects.toThrow("input mismatch");
  });
  it("rejects new claims after deletion starts without inserting a receipt", async () => {
    ctx.tables.set("user_deletion_fences", [{ user_id: identity.user_id }]);
    await expect(start(ctx)).rejects.toThrow("deletion is in progress");
    expect(ctx.tables.get("usage_settlement_operations")).toBeUndefined();
  });
  it("rejects a new debit and reload linkage when deletion starts after the claim", async () => {
    await start(ctx);
    ctx.tables.set("user_deletion_fences", [{ user_id: identity.user_id }]);
    const execute = jest.fn(async () => applyDebit(ctx, 80));
    await expect(recordWalletDebit(ctx, identity, 0, execute)).rejects.toThrow(
      "deletion is in progress",
    );
    await expect(
      (linkAutoReload as any).handler(ctx, {
        ...identity,
        auto_reload_operation_id: "reload-1",
      }),
    ).rejects.toThrow("deletion is in progress");
    expect(execute).not.toHaveBeenCalled();
    expect(ctx.tables.get("extra_usage")[0].balance_points).toBe(100);
    expect((await read(ctx)).debits).toHaveLength(0);
  });
  it("preserves applied evidence under the anonymized scope without resuming the action", async () => {
    await start(ctx);
    await recordWalletDebit(ctx, identity, 0, async () => applyDebit(ctx, 80));
    ctx.tables.get("usage_settlement_operations")[0].user_id =
      "__deleted_user__";
    ctx.tables.get("usage_settlement_debits")[0].user_id = "__deleted_user__";
    await expect(
      (finish as any).handler(ctx, { ...identity, result }),
    ).rejects.toThrow("input mismatch");
    const retained = await read(ctx, {
      ...identity,
      user_id: "__deleted_user__",
    });
    expect(retained.status).toBe("pending");
    expect(retained.debits[0].outcome).toBe("applied");
  });
  it("requires service authorization for receipt reads", async () => {
    await expect(
      (getForBackend as any).handler(ctx, { ...identity, serviceKey: "wrong" }),
    ).rejects.toThrow("Unauthorized");
  });
});

describe("action-level financial fences", () => {
  function actionContext() {
    const ctx: any = database();
    ctx.runMutation = async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "settlementReceipts:begin")
        return (begin as any).handler(ctx, args);
      if (name === "settlementReceipts:finish")
        return (finish as any).handler(ctx, args);
      throw Error(name);
    };
    return ctx;
  }
  const args = {
    serviceKey: "test-key",
    userId: identity.user_id,
    amountPoints: 20,
    usageSettlementId: "synthetic",
    settlementOperationId: identity.operation_id,
  };
  it("returns a completed outcome without another debit or Stripe reload", async () => {
    const ctx = actionContext();
    const execute = jest.fn(async () => result);
    await runWalletSettlement(ctx, args, execute);
    expect(await runWalletSettlement(ctx, args, execute)).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("fences duplicate concurrent actions and permits only the original executor", async () => {
    const ctx = actionContext();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = runWalletSettlement(ctx, args, async () => {
      entered();
      await gate;
      return result;
    });
    // Observe the original executor after its durable claim, without assuming microtask timing.
    await started;
    await expect(
      runWalletSettlement(ctx, args, async () => result),
    ).rejects.toThrow("outcome unknown");
    release();
    expect(await first).toEqual(result);
  });
  it("does not repeat an action after failure following the wallet debit", async () => {
    const ctx = actionContext();
    const execute = jest.fn(async () => {
      await recordWalletDebit(ctx, identity, 0, async () =>
        applyDebit(ctx, 80),
      );
      throw Error("lost action response");
    });
    await expect(runWalletSettlement(ctx, args, execute)).rejects.toThrow(
      "lost action response",
    );
    await expect(runWalletSettlement(ctx, args, execute)).rejects.toThrow(
      "outcome unknown",
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await read(ctx)).debits[0].outcome).toBe("applied");
  });
  it("rejects a duplicate with changed scope before calling the action", async () => {
    const ctx = actionContext();
    await runWalletSettlement(ctx, args, async () => result);
    const execute = jest.fn(async () => result);
    await expect(
      runWalletSettlement(ctx, { ...args, amountPoints: 21 }, execute),
    ).rejects.toThrow("input mismatch");
    expect(execute).not.toHaveBeenCalled();
  });
});
