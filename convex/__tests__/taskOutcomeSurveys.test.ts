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
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "user-1" }) },
    db: {
      query: (table: string) => {
        let matching: any[] = [];
        const chain: any = {
          withIndex: (_: string, select: (q: any) => unknown) => {
            const q = {
              eq: (key: string, value: unknown) => {
                matching = (
                  table === "chats"
                    ? [{ id: "chat-1", user_id: "user-1" }]
                    : rows
                ).filter((row) => row[key] === value);
                return q;
              },
            };
            select(q);
            return chain;
          },
          order: () => chain,
          first: async () => matching.at(-1) ?? null,
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
  return { ctx, rows };
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
