import {
  reserve,
  record,
  getForMessage,
  linkMessage,
} from "../taskOutcomeSurveys";
import { TASK_OUTCOME_COOLDOWN_MS } from "../../lib/feedback/task-outcome";
jest.mock("../_generated/server", () => ({
  mutation: (x: unknown) => x,
  query: (x: unknown) => x,
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "test") throw Error("Unauthorized");
  },
}));
jest.mock("../lib/userDeletionFence", () => ({
  isUserDeletionFenced: jest.fn(async () => false),
}));
const invoke = (fn: unknown, ctx: unknown, args: unknown) =>
  (fn as { handler: (c: unknown, a: unknown) => Promise<any> }).handler(
    ctx,
    args,
  );
const args = {
  serviceKey: "test",
  user_id: "user-1",
  chat_id: "chat-1",
  request_id: "run-1",
  message_id: "run-1",
  experiment_variant: "test",
  baseline_model: "baseline",
  assigned_model: "treatment",
  mode: "agent",
  subscription_tier: "pro",
  release: "test-release",
};
function setup() {
  const rows: any[] = [];
  const paidStarts: any[] = [];
  const payments: any[] = [];
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "user-1" }) },
    db: {
      query: (table: string) => {
        let matching: any[] =
          table === "chats"
            ? [{ id: "chat-1", user_id: "user-1" }]
            : table === "paid_start_events"
              ? paidStarts
              : table === "revenue_events"
                ? payments
                : rows;
        let direction = "asc";
        const chain: any = {
          withIndex: (_: string, select: (q: any) => unknown) => {
            const q = {
              eq: (key: string, value: unknown) => {
                matching = matching.filter((row) => row[key] === value);
                return q;
              },
            };
            select(q);
            return chain;
          },
          order: (value: string) => {
            direction = value;
            return chain;
          },
          first: async () =>
            (direction === "desc" ? matching.at(-1) : matching[0]) ?? null,
          unique: async () => {
            if (matching.length > 1) throw Error("Duplicate");
            return matching[0] ?? null;
          },
        };
        return chain;
      },
      insert: async (_: string, value: any) => {
        const id = `survey-${rows.length}`;
        rows.push({ _id: id, _creationTime: Date.now(), ...value });
        return id;
      },
      get: async (id: string) => rows.find((r) => r._id === id) ?? null,
      patch: async (id: string, patch: any) => {
        const index = rows.findIndex((r) => r._id === id);
        rows[index] = { ...rows[index], ...patch };
      },
    },
  };
  return { ctx, rows, paidStarts, payments };
}
describe("task outcome feedback", () => {
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  });
  afterEach(() => jest.restoreAllMocks());
  it("retains free Ask experiment attribution through replacement message linkage and feedback", async () => {
    const { ctx } = setup();
    const survey = await invoke(reserve, ctx, {
      ...args,
      experiment_key: "abliterated_free_ask_moderated_v1",
      mode: "ask",
      subscription_tier: "free",
    });
    await invoke(linkMessage, ctx, {
      serviceKey: "test",
      user_id: "user-1",
      request_id: "run-1",
      message_id: "replacement",
    });
    await invoke(record, ctx, { id: survey._id, action: "shown" });
    const answered = await invoke(record, ctx, {
      id: survey._id,
      action: "answered",
      answer: "yes",
    });
    expect(answered).toMatchObject({
      experiment_key: "abliterated_free_ask_moderated_v1",
      request_id: "run-1",
      message_id: "replacement",
      answer: "yes",
    });
  });
  it("reserves before outcomes and enforces a rolling 72-hour cross-device cooldown", async () => {
    const { ctx, rows } = setup();
    expect(await invoke(reserve, ctx, args)).toMatchObject({
      request_id: "run-1",
    });
    expect(
      await invoke(reserve, ctx, { ...args, request_id: "run-2" }),
    ).toBeNull();
    const nextEligibleAt = rows[0].selected_at + 72 * 60 * 60 * 1000;
    jest.mocked(Date.now).mockReturnValue(nextEligibleAt - 1);
    expect(
      await invoke(reserve, ctx, { ...args, request_id: "run-2" }),
    ).toBeNull();
    jest.mocked(Date.now).mockReturnValue(nextEligibleAt);
    expect(
      await invoke(reserve, ctx, { ...args, request_id: "run-2" }),
    ).not.toBeNull();
    expect(rows).toHaveLength(2);
  });
  it("does not reserve the same request twice even after cooldown", async () => {
    const { ctx, rows } = setup();
    await invoke(reserve, ctx, args);
    jest
      .mocked(Date.now)
      .mockReturnValue(rows[0].selected_at + TASK_OUTCOME_COOLDOWN_MS);
    expect(await invoke(reserve, ctx, args)).toBeNull();
  });
  it("allows only one device to claim a prompt and extends cooldown from interaction", async () => {
    const { ctx, rows } = setup();
    const row = await invoke(reserve, ctx, args);
    jest.mocked(Date.now).mockReturnValue(row.selected_at + 1000);
    expect(
      await invoke(record, ctx, { id: row._id, action: "shown" }),
    ).not.toBeNull();
    expect(
      await invoke(record, ctx, { id: row._id, action: "shown" }),
    ).toBeNull();
    expect(rows[0].last_interaction_at).toBe(row.selected_at + 1000);
    const nextEligibleAt = row.selected_at + 1000 + 72 * 60 * 60 * 1000;
    jest.mocked(Date.now).mockReturnValue(nextEligibleAt - 1);
    expect(
      await invoke(reserve, ctx, { ...args, request_id: "run-2" }),
    ).toBeNull();
    jest.mocked(Date.now).mockReturnValue(nextEligibleAt);
    expect(
      await invoke(reserve, ctx, { ...args, request_id: "run-2" }),
    ).not.toBeNull();
  });
  it("preserves assignment while linking a fallback response", async () => {
    const { ctx } = setup();
    await invoke(reserve, ctx, args);
    await invoke(linkMessage, ctx, { ...args, message_id: "fallback" });
    expect(
      await invoke(getForMessage, ctx, {
        chat_id: "chat-1",
        message_id: "run-1",
      }),
    ).toBeNull();
    expect(
      await invoke(getForMessage, ctx, {
        chat_id: "chat-1",
        message_id: "fallback",
      }),
    ).toMatchObject({ request_id: "run-1", experiment_variant: "test" });
  });
  it("stores answers without requiring a reason and rejects mismatched reasons", async () => {
    const { ctx } = setup();
    const row = await invoke(reserve, ctx, args);
    await invoke(record, ctx, { id: row._id, action: "shown" });
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "answered",
        answer: "no",
      }),
    ).toMatchObject({ answer: "no" });
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "reason",
        reason: "solved_task",
      }),
    ).toBeNull();
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "reason",
        reason: "incorrect",
      }),
    ).toMatchObject({ answer: "no", reason: "incorrect" });
  });
  it("rejects other accounts, invalid service keys and expired prompts", async () => {
    const { ctx } = setup();
    const row = await invoke(reserve, ctx, args);
    await expect(
      invoke(reserve, ctx, { ...args, serviceKey: "wrong" }),
    ).rejects.toThrow();
    ctx.auth.getUserIdentity = async () => ({ subject: "someone-else" });
    expect(await invoke(getForMessage, ctx, args)).toBeNull();
    await expect(
      invoke(record, ctx, { id: row._id, action: "shown" }),
    ).rejects.toThrow();
    ctx.auth.getUserIdentity = async () => ({ subject: "user-1" });
    jest.mocked(Date.now).mockReturnValue(row.expires_at);
    expect(
      await invoke(record, ctx, { id: row._id, action: "shown" }),
    ).toBeNull();
  });
});

const paidArgs = {
  ...args,
  survey_kind: "new_paid",
  experiment_variant: undefined,
  baseline_model: undefined,
  assigned_model: undefined,
};
function paidSetup() {
  const setupValue = setup();
  setupValue.paidStarts.push({
    _id: "paid-1",
    entity_type: "user",
    entity_id: "user-1",
    tier: "pro",
    occurred_at: Date.now() - 3600000,
    stripe_subscription_id: "sub-1",
    stripe_invoice_id: "in-1",
    billing_period_end: Date.now() + 30 * 86400000,
    billing_interval: "month",
  });
  setupValue.payments.push({
    idempotency_key: "subscription:in-1:user:user-1",
    entity_type: "user",
    entity_id: "user-1",
    source: "subscription",
    gross_revenue_dollars: 20,
    stripe_subscription_id: "sub-1",
    stripe_invoice_id: "in-1",
  });
  return setupValue;
}
describe("new paid cohort", () => {
  it("enrolls without a model assignment and freezes billing evidence", async () => {
    const { ctx, paidStarts, rows } = paidSetup();
    const row = await invoke(reserve, ctx, paidArgs);
    expect(row).toMatchObject({
      survey_kind: "new_paid",
      baseline_renewal_at: paidStarts[0].billing_period_end,
      stripe_subscription_id: "sub-1",
    });
    expect(row.experiment_variant).toBeUndefined();
    paidStarts[0].billing_period_end += 86400000;
    expect(rows[0].baseline_renewal_at).toBe(row.baseline_renewal_at);
  });
  it.each(["free", "team"])("excludes %s plans", async (tier) => {
    const { ctx } = paidSetup();
    expect(
      await invoke(reserve, ctx, { ...paidArgs, subscription_tier: tier }),
    ).toBeNull();
  });
  it.each([
    "missing",
    "old",
    "future",
    "resubscribed",
    "zero",
    "wrong_payment",
    "organization",
  ])("excludes %s billing evidence", async (condition) => {
    const { ctx, paidStarts, payments } = paidSetup();
    if (condition === "missing") paidStarts.length = 0;
    if (condition === "old")
      paidStarts[0].occurred_at = Date.now() - 7 * 86400000;
    if (condition === "future")
      paidStarts[0].occurred_at = Date.now() + 86400000;
    if (condition === "resubscribed")
      paidStarts.push({ ...paidStarts[0], _id: "paid-2" });
    if (condition === "zero") payments[0].gross_revenue_dollars = 0;
    if (condition === "wrong_payment")
      payments[0].stripe_subscription_id = "other";
    if (condition === "organization") paidStarts[0].organization_id = "org";
    expect(await invoke(reserve, ctx, paidArgs)).toBeNull();
  });
  it("shares the legacy cooldown and never invites a paid cohort member twice", async () => {
    const { ctx, rows } = paidSetup();
    await invoke(reserve, ctx, args);
    expect(
      await invoke(reserve, ctx, { ...paidArgs, request_id: "new" }),
    ).toBeNull();
    rows[0].last_interaction_at -= TASK_OUTCOME_COOLDOWN_MS;
    const row = await invoke(reserve, ctx, { ...paidArgs, request_id: "new" });
    expect(row).not.toBeNull();
    rows[1].last_interaction_at -= TASK_OUTCOME_COOLDOWN_MS;
    expect(
      await invoke(reserve, ctx, { ...paidArgs, request_id: "another" }),
    ).toBeNull();
  });
  it("distinguishes actual view from claim and stores explicit solved without a reason", async () => {
    const { ctx } = paidSetup();
    const row = await invoke(reserve, ctx, paidArgs);
    expect(
      await invoke(record, ctx, { id: row._id, action: "viewed" }),
    ).toBeNull();
    const claimed = await invoke(record, ctx, { id: row._id, action: "shown" });
    expect(claimed.viewed_at).toBeUndefined();
    expect(
      await invoke(record, ctx, { id: row._id, action: "viewed" }),
    ).toHaveProperty("viewed_at");
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "answered",
        answer: "yes",
      }),
    ).toBeNull();
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "answered",
        answer: "solved",
      }),
    ).toMatchObject({ answer: "solved" });
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "answered",
        answer: "helpful",
      }),
    ).toBeNull();
  });
});
