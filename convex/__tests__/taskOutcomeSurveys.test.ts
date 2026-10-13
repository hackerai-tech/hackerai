import {
  getForMessage,
  linkMessage,
  record,
  reserve,
  reserveExperiment,
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

describe("current experiment reservation", () => {
  const experimentArgs = {
    ...args,
    survey_kind: "current_experiment",
    experiment_key: "abliterated_max_moderated_v1",
    experiment_variant: "control",
    experiment_request_id: args.request_id,
    feedback_phase: "abliterated_max_moderated_feedback_v1",
    selected_model_override: "hackerai-max",
    assigned_model: "baseline",
    baseline_model: "baseline",
  };
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000));
  afterEach(() => jest.restoreAllMocks());
  it.each([
    [
      "abliterated_paid_first_step_v2",
      "abliterated_paid_first_step_feedback_v2",
      "control",
    ],
    [
      "abliterated_paid_first_step_v2",
      "abliterated_paid_first_step_feedback_v2",
      "test",
    ],
    [
      "abliterated_paid_moderated_default_v1",
      "abliterated_paid_moderated_default_feedback_v1",
      "test",
    ],
  ])(
    "reserves and answers new phase %s/%s/%s without rewriting old invitations",
    async (key, phase, variant) => {
      const { ctx, rows } = setup();
      const old = await invoke(reserveExperiment, ctx, experimentArgs);
      const next = {
        ...experimentArgs,
        request_id: "new",
        message_id: "new",
        experiment_request_id: "new",
        experiment_key: key,
        feedback_phase: phase,
        experiment_variant: variant,
        selected_model_override: "hackerai-standard",
      };
      expect(await invoke(reserveExperiment, ctx, next)).toBeNull();
      jest
        .mocked(Date.now)
        .mockReturnValue(Date.now() + TASK_OUTCOME_COOLDOWN_MS + 1);
      const current = await invoke(reserveExperiment, ctx, next);
      expect(current).toMatchObject({
        experiment_key: key,
        feedback_phase: phase,
      });
      await invoke(record, ctx, { id: current._id, action: "shown" });
      await invoke(record, ctx, { id: current._id, action: "viewed" });
      await invoke(record, ctx, {
        id: current._id,
        action: "answered",
        answer: "solved",
      });
      expect(rows[1]).toMatchObject({
        answer: "solved",
        experiment_key: key,
        experiment_variant: variant,
      });
      expect(rows[0]).toEqual(old);
      expect(
        await invoke(getForMessage, ctx, {
          chat_id: "chat-1",
          message_id: "new",
        }),
      ).toBeNull();
      jest
        .mocked(Date.now)
        .mockReturnValue(Date.now() + TASK_OUTCOME_COOLDOWN_MS + 1);
      expect(
        await invoke(reserveExperiment, ctx, {
          ...next,
          request_id: "again",
          message_id: "again",
          experiment_request_id: "again",
        }),
      ).toBeNull();
    },
  );
  it.each([
    { experiment_key: "abliterated_paid_first_step_v2" },
    { feedback_phase: "abliterated_paid_first_step_feedback_v2" },
    { selected_model_override: "hackerai-standard" },
    {
      experiment_key: "abliterated_paid_moderated_default_v1",
      feedback_phase: "abliterated_paid_moderated_default_feedback_v1",
      experiment_variant: "control",
    },
  ])("rejects cross-phase and invalid cohort context", async (patch) => {
    const { ctx, rows } = setup();
    expect(
      await invoke(reserveExperiment, ctx, { ...experimentArgs, ...patch }),
    ).toBeNull();
    expect(rows).toEqual([]);
  });
  it.each(["control", "test"])(
    "reserves %s without first-week payment evidence",
    async (experiment_variant) => {
      const { ctx, paidStarts, payments, rows } = setup();
      paidStarts.length = 0;
      payments.length = 0;
      expect(
        await invoke(reserveExperiment, ctx, {
          ...experimentArgs,
          experiment_variant,
          subscription_tier: "team",
        }),
      ).toMatchObject({
        experiment_variant,
        experiment_request_id: args.request_id,
        selected_at: Date.now(),
      });
      expect(rows[0]).not.toHaveProperty("paid_start_event_id");
    },
  );
  it("retains original assignment through replacement messages and repeated requests", async () => {
    const { ctx, rows } = setup();
    await invoke(reserveExperiment, ctx, experimentArgs);
    expect(
      await invoke(reserveExperiment, ctx, {
        ...experimentArgs,
        experiment_variant: "test",
      }),
    ).toBeNull();
    await invoke(linkMessage, ctx, { ...args, message_id: "recovery" });
    expect(rows[0]).toMatchObject({
      request_id: args.request_id,
      experiment_request_id: args.request_id,
      experiment_variant: "control",
      message_id: "recovery",
    });
    expect(rows).toHaveLength(1);
  });
  it("never invites the same user twice in the same phase after expiry or dismissal", async () => {
    const { ctx, rows } = setup();
    const row = await invoke(reserveExperiment, ctx, experimentArgs);
    await invoke(record, ctx, { id: row._id, action: "shown" });
    await invoke(record, ctx, { id: row._id, action: "dismissed" });
    jest
      .mocked(Date.now)
      .mockReturnValue(Date.now() + TASK_OUTCOME_COOLDOWN_MS + 1);
    expect(
      await invoke(reserveExperiment, ctx, {
        ...experimentArgs,
        request_id: "next",
        experiment_request_id: "next",
        message_id: "next",
      }),
    ).toBeNull();
    expect(rows).toHaveLength(1);
  });
  it("shares the cooldown with historical cohorts and preserves selected nonresponse", async () => {
    const { ctx, rows } = setup();
    await invoke(reserve, ctx, args);
    const next = {
      ...experimentArgs,
      request_id: "next",
      experiment_request_id: "next",
      message_id: "next",
    };
    expect(await invoke(reserveExperiment, ctx, next)).toBeNull();
    jest
      .mocked(Date.now)
      .mockReturnValue(Date.now() + TASK_OUTCOME_COOLDOWN_MS + 1);
    const row = await invoke(reserveExperiment, ctx, next);
    expect(row).not.toBeNull();
    jest.mocked(Date.now).mockReturnValue(row.expires_at);
    expect(
      await invoke(getForMessage, ctx, {
        chat_id: args.chat_id,
        message_id: "next",
      }),
    ).toBeNull();
    expect(rows[1]).not.toHaveProperty("answer");
    expect(rows[1]).not.toHaveProperty("viewed_at");
  });
  it("keeps claim distinct from view and makes answers idempotent", async () => {
    const { ctx, rows } = setup();
    const row = await invoke(reserveExperiment, ctx, experimentArgs);
    await invoke(record, ctx, { id: row._id, action: "shown" });
    expect(rows[0]).not.toHaveProperty("viewed_at");
    expect(
      await invoke(record, ctx, { id: row._id, action: "shown" }),
    ).toBeNull();
    await invoke(record, ctx, { id: row._id, action: "viewed" });
    await invoke(record, ctx, {
      id: row._id,
      action: "answered",
      answer: "not_checked",
    });
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "answered",
        answer: "not_checked",
      }),
    ).toMatchObject({ answer: "not_checked" });
    expect(
      await invoke(record, ctx, {
        id: row._id,
        action: "answered",
        answer: "solved",
      }),
    ).toBeNull();
    expect(await invoke(getForMessage, ctx, args)).toBeNull();
  });
  it("rejects free users, mismatched requests, nonowners and bad service credentials", async () => {
    const { ctx } = setup();
    for (const patch of [
      { subscription_tier: "free" },
      { experiment_request_id: "other" },
      { message_id: "other" },
      { user_id: "other" },
    ]) {
      expect(
        await invoke(reserveExperiment, ctx, { ...experimentArgs, ...patch }),
      ).toBeNull();
    }
    await expect(
      invoke(reserveExperiment, ctx, {
        ...experimentArgs,
        serviceKey: "wrong",
      }),
    ).rejects.toThrow();
    const row = await invoke(reserveExperiment, ctx, experimentArgs);
    ctx.auth.getUserIdentity = async () => ({ subject: "other" });
    await expect(
      invoke(record, ctx, {
        id: row._id,
        action: "answered",
        answer: "solved",
      }),
    ).rejects.toThrow();
  });
});
