import {
  getForMessage,
  linkMessage,
  record,
  reserve,
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
  survey_kind: "new_paid" as const,
  mode: "agent" as const,
  subscription_tier: "pro",
  release: "test-release",
};

function setup() {
  const rows: any[] = [];
  const paidStarts: any[] = [
    {
      _id: "paid-1",
      entity_type: "user",
      entity_id: "user-1",
      tier: "pro",
      occurred_at: Date.now() - 3_600_000,
      stripe_subscription_id: "sub-1",
      stripe_invoice_id: "in-1",
      billing_period_end: Date.now() + 30 * 86_400_000,
      billing_interval: "month",
    },
  ];
  const payments: any[] = [
    {
      idempotency_key: "subscription:in-1:user:user-1",
      entity_type: "user",
      entity_id: "user-1",
      source: "subscription",
      gross_revenue_dollars: 20,
      stripe_subscription_id: "sub-1",
      stripe_invoice_id: "in-1",
    },
  ];
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
      get: async (id: string) => rows.find((row) => row._id === id) ?? null,
      patch: async (id: string, patch: any) => {
        const index = rows.findIndex((row) => row._id === id);
        rows[index] = { ...rows[index], ...patch };
      },
    },
  };
  return { ctx, rows, paidStarts, payments };
}

describe("new paid task outcome feedback", () => {
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  });
  afterEach(() => jest.restoreAllMocks());

  it("enrolls without model attribution and freezes billing evidence", async () => {
    const { ctx, paidStarts, rows } = setup();
    const row = await invoke(reserve, ctx, args);

    expect(row).toMatchObject({
      survey_kind: "new_paid",
      baseline_renewal_at: paidStarts[0].billing_period_end,
      stripe_subscription_id: "sub-1",
    });
    expect(row).not.toHaveProperty("experiment_variant");
    paidStarts[0].billing_period_end += 86_400_000;
    expect(rows[0].baseline_renewal_at).toBe(row.baseline_renewal_at);
  });

  it.each(["free", "team"])("excludes %s plans", async (tier) => {
    const { ctx } = setup();
    expect(
      await invoke(reserve, ctx, { ...args, subscription_tier: tier }),
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
    const { ctx, paidStarts, payments } = setup();
    if (condition === "missing") paidStarts.length = 0;
    if (condition === "old")
      paidStarts[0].occurred_at = Date.now() - 7 * 86_400_000;
    if (condition === "future")
      paidStarts[0].occurred_at = Date.now() + 86_400_000;
    if (condition === "resubscribed")
      paidStarts.push({ ...paidStarts[0], _id: "paid-2" });
    if (condition === "zero") payments[0].gross_revenue_dollars = 0;
    if (condition === "wrong_payment")
      payments[0].stripe_subscription_id = "other";
    if (condition === "organization") paidStarts[0].organization_id = "org";

    expect(await invoke(reserve, ctx, args)).toBeNull();
  });

  it("enforces cooldown and enrolls each paid cohort member once", async () => {
    const { ctx, rows } = setup();
    const first = await invoke(reserve, ctx, args);
    expect(first).not.toBeNull();
    expect(
      await invoke(reserve, ctx, { ...args, request_id: "run-2" }),
    ).toBeNull();

    rows[0].last_interaction_at -= TASK_OUTCOME_COOLDOWN_MS;
    expect(
      await invoke(reserve, ctx, { ...args, request_id: "run-2" }),
    ).toBeNull();
  });

  it("links recovery messages while preserving the original request", async () => {
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
    ).toMatchObject({ request_id: "run-1", survey_kind: "new_paid" });
  });

  it("records view, answer, and only matching structured reasons", async () => {
    const { ctx } = setup();
    const row = await invoke(reserve, ctx, args);
    expect(
      await invoke(record, ctx, { id: row._id, action: "viewed" }),
    ).toBeNull();
    await invoke(record, ctx, { id: row._id, action: "shown" });
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "answered",
        answer: "helpful",
      }),
    ).toMatchObject({ answer: "helpful" });
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "reason",
        reason: "incorrect",
      }),
    ).toBeNull();
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "reason",
        reason: "clear_explanation",
      }),
    ).toMatchObject({ answer: "helpful", reason: "clear_explanation" });
  });

  it("rejects other accounts, invalid service keys, and expired prompts", async () => {
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
