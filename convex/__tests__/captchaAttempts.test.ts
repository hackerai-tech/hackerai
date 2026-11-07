import { beforeEach, afterEach, expect, it, jest } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: (c: unknown) => c,
  internalMutation: (c: unknown) => c,
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "service-key") throw new Error("Unauthorized");
  },
}));
const journal =
  require("../captchaAttempts") as typeof import("../captchaAttempts");
type Row = Record<string, any> & { _id: string };
const originalEnv = process.env;
beforeEach(() => {
  process.env = {
    ...originalEnv,
    HACKERAI_CAPTCHA_JOURNAL_ENABLED: "1",
    TWOCAPTCHA_API_KEY: "secret-key",
  };
});
afterEach(() => {
  process.env = originalEnv;
});
function fixture() {
  let sequence = 0;
  const rows: Record<string, Row[]> = {
    chats: [
      {
        _id: "chat",
        id: "chat",
        user_id: "user",
        active_trigger_run_id: "run",
      },
    ],
    captcha_attempts: [],
    captcha_daily_limits: [],
    user_deletion_fences: [],
  };
  const find = (id: string) =>
    Object.values(rows)
      .flat()
      .find((r) => r._id === id);
  const ctx = {
    scheduler: { runAfter: jest.fn(async () => "job") },
    db: {
      query: (table: string) => ({
        withIndex: (_index: string, select: (q: any) => unknown) => {
          const conditions: Record<string, unknown> = {};
          const q = {
            eq: (key: string, value: unknown) => {
              conditions[key] = value;
              return q;
            },
          };
          select(q);
          return {
            first: async () =>
              rows[table].find((r) =>
                Object.entries(conditions).every(([k, v]) => r[k] === v),
              ) ?? null,
          };
        },
      }),
      get: async (id: string) => find(id) ?? null,
      insert: async (table: string, data: Record<string, unknown>) => {
        const id = "id-" + ++sequence;
        rows[table].push({ _id: id, ...data });
        return id;
      },
      patch: async (id: string, fields: Record<string, unknown>) =>
        Object.assign(find(id)!, fields),
    },
  };
  const scope = { serviceKey: "service-key", userId: "user", runId: "run" };
  const reserve = () =>
    journal.reserve.handler(ctx as never, {
      ...scope,
      chatId: "chat",
      kind: "hcaptcha",
    });
  return { rows, ctx, scope, reserve };
}

it("admits once per run and journals a watchdog before any external work", async () => {
  const f = fixture();
  expect(await f.reserve()).toBe(true);
  expect(await f.reserve()).toBe(false);
  expect(f.rows.captcha_attempts).toHaveLength(1);
  expect(f.rows.captcha_daily_limits.map((r) => r.attempts)).toEqual([1, 1]);
  expect(f.ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.rows.captcha_attempts)).not.toContain("secret-key");
});

it.each([
  "wrong user",
  "ended run",
  "deleting chat",
  "deleting user",
  "missing key",
  "disabled journal",
  "zero limit",
])("refuses admission for %s", async (variant) => {
  const f = fixture();
  if (variant === "wrong user") f.rows.chats[0].user_id = "other";
  if (variant === "ended run")
    f.rows.chats[0].active_trigger_run_id = "new-run";
  if (variant === "deleting chat") f.rows.chats[0].deletion_started_at = 1;
  if (variant === "deleting user")
    f.rows.user_deletion_fences.push({ _id: "fence", user_id: "user" });
  if (variant === "missing key") delete process.env.TWOCAPTCHA_API_KEY;
  if (variant === "disabled journal")
    delete process.env.HACKERAI_CAPTCHA_JOURNAL_ENABLED;
  if (variant === "zero limit") process.env.CAPTCHA_SOLVER_DAILY_ATTEMPTS = "0";
  expect(await f.reserve()).toBe(false);
  expect(f.rows.captcha_attempts).toHaveLength(0);
  expect(f.ctx.scheduler.runAfter).not.toHaveBeenCalled();
});

it("holds daily capacity for an unknown creation and denies subsequent runs", async () => {
  process.env.CAPTCHA_SOLVER_USER_DAILY_ATTEMPTS = "1";
  const f = fixture();
  expect(await f.reserve()).toBe(true);
  f.scope.runId = "run-2";
  f.rows.chats[0].active_trigger_run_id = "run-2";
  expect(await f.reserve()).toBe(false);
  expect(f.rows.captcha_daily_limits.map((r) => r.attempts)).toEqual([1, 1]);
});

it("reconciles a late fee after the parent ends, once, without a customer deduction", async () => {
  const f = fixture();
  await f.reserve();
  await journal.registerTask.handler(f.ctx as never, {
    ...f.scope,
    taskId: 123,
  });
  const row = f.rows.captcha_attempts[0];
  f.rows.chats[0].active_trigger_run_id = null;
  expect(
    await journal.beginReconciliation.handler(f.ctx as never, {
      id: row._id as never,
    }),
  ).toEqual({ taskId: 123 });
  expect(f.ctx.scheduler.runAfter).toHaveBeenCalledTimes(2);
  await journal.settleReconciliation.handler(f.ctx as never, {
    id: row._id as never,
    taskId: 123,
    costDollars: 0.00299,
    unsolvable: false,
  });
  await journal.settleReconciliation.handler(f.ctx as never, {
    id: row._id as never,
    taskId: 123,
    costDollars: 0.5,
    unsolvable: false,
  });
  expect(row).toMatchObject({ state: "ready", cost_dollars: 0.00299 });
  expect(
    await journal.beginReconciliation.handler(f.ctx as never, {
      id: row._id as never,
    }),
  ).toBeNull();
  expect(f.ctx.scheduler.runAfter).toHaveBeenCalledTimes(2);
});

it("keeps an unidentified creation unknown after bounded polling and never admits it again", async () => {
  const f = fixture();
  await f.reserve();
  const row = f.rows.captcha_attempts[0];
  for (let n = 0; n < 20; n++)
    expect(
      await journal.beginReconciliation.handler(f.ctx as never, {
        id: row._id as never,
      }),
    ).toEqual({ taskId: null });
  expect(
    await journal.beginReconciliation.handler(f.ctx as never, {
      id: row._id as never,
    }),
  ).toBeNull();
  expect(row.state).toBe("unknown");
  expect(await f.reserve()).toBe(false);
  expect(f.ctx.scheduler.runAfter).toHaveBeenCalledTimes(21);
});

it("rejects cross-owner/task writes and conflicting cost instead of overwriting a receipt", async () => {
  const f = fixture();
  await f.reserve();
  await expect(
    journal.registerTask.handler(f.ctx as never, {
      ...f.scope,
      serviceKey: "wrong",
      taskId: 123,
    }),
  ).rejects.toThrow("Unauthorized");
  await expect(
    journal.registerTask.handler(f.ctx as never, {
      ...f.scope,
      userId: "other",
      taskId: 123,
    }),
  ).rejects.toThrow("identity");
  await journal.registerTask.handler(f.ctx as never, {
    ...f.scope,
    taskId: 123,
  });
  await expect(
    journal.registerTask.handler(f.ctx as never, { ...f.scope, taskId: 124 }),
  ).rejects.toThrow("identity");
  await journal.recordCost.handler(f.ctx as never, {
    ...f.scope,
    taskId: 123,
    costDollars: 0.003,
  });
  await journal.recordCost.handler(f.ctx as never, {
    ...f.scope,
    taskId: 123,
    costDollars: 0.003,
  });
  await expect(
    journal.recordCost.handler(f.ctx as never, {
      ...f.scope,
      taskId: 123,
      costDollars: 0.004,
    }),
  ).rejects.toThrow("Conflicting");
});
