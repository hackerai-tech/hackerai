jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
const mockValidate = jest.fn();
jest.mock("../lib/utils", () => ({
  validateServiceKey: (...args: unknown[]) => mockValidate(...args),
}));
const mockAccess = jest.fn();
jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: (...args: unknown[]) => mockAccess(...args),
}));
const {
  getForBackend,
  saveForBackend,
  consumeForBackend,
} = require("../nextActions");
const batch = {
  batchId: "batch",
  messageId: "answer",
  mode: "ask",
  suggestions: ["Explain the missing evidence."],
};
const args = {
  serviceKey: "test-only",
  userId: "owner",
  chatId: "chat",
  messageId: "answer",
};
function context(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, any> = {
    chats: {
      _id: "row",
      user_id: "owner",
      default_model_slug: "ask",
      finish_reason: "stop",
      last_run_finished_at: 123,
    },
    messages: { id: "answer", role: "assistant", user_id: "owner" },
    user_deletion_fences: null,
    ...overrides,
  };
  const q: any = { eq: () => q };
  const db = {
    query: jest.fn((table: string) => {
      const chain: any = {
        withIndex: (_name: string, fn: (q: any) => void) => {
          fn(q);
          return chain;
        },
        order: () => chain,
        first: async () => rows[table] ?? null,
      };
      return chain;
    }),
    patch: jest.fn(async (_id, update) => Object.assign(rows.chats, update)),
  };
  return { db, rows };
}
beforeEach(() => jest.clearAllMocks());
it("saves and restores the same bounded batch without changing the sidebar sort time", async () => {
  const ctx = context();
  expect(
    await saveForBackend.handler(ctx, { ...args, finishedAt: 123, batch }),
  ).toEqual(batch);
  expect(await getForBackend.handler(ctx, args)).toEqual({
    messageId: "answer",
    finishedAt: 123,
    consumed: false,
    batch,
  });
  expect(ctx.db.patch.mock.calls[0][1]).not.toHaveProperty("update_time");
});
it("consumption removes content and fences an in-flight or duplicate save", async () => {
  const ctx = context();
  await consumeForBackend.handler(ctx, args);
  expect(ctx.rows.chats.next_actions).toEqual({
    messageId: "answer",
    finishedAt: 123,
    consumed: true,
  });
  expect(
    await saveForBackend.handler(ctx, { ...args, finishedAt: 123, batch }),
  ).toBeNull();
  expect((await getForBackend.handler(ctx, args)).consumed).toBe(true);
});
it.each([
  { user_id: "other" },
  { deletion_started_at: 1 },
  { canceled_at: 1 },
  { active_trigger_run_id: "new-run" },
  { active_stream_id: "stream" },
  { active_agent_approval_pending: true },
  { finish_reason: "error" },
])("rejects inaccessible or unsettled state %j", async (override) => {
  const ctx = context();
  Object.assign(ctx.rows.chats, override);
  expect(
    await saveForBackend.handler(ctx, { ...args, finishedAt: 123, batch }),
  ).toBeNull();
  expect(await getForBackend.handler(ctx, args)).toBeNull();
  expect(await consumeForBackend.handler(ctx, args)).toBe(false);
  expect(ctx.db.patch).not.toHaveBeenCalled();
});
it("does not return or overwrite a stale message, completion, or mode", async () => {
  for (const override of [
    { messages: { id: "new", role: "assistant", user_id: "owner" } },
    { messages: { id: "answer", role: "user", user_id: "owner" } },
    {
      chats: {
        _id: "row",
        user_id: "owner",
        finish_reason: "stop",
        last_run_finished_at: 124,
        default_model_slug: "ask",
        next_actions: {
          messageId: "answer",
          finishedAt: 123,
          consumed: false,
          batch,
        },
      },
    },
  ]) {
    const ctx = context(override);
    expect(await getForBackend.handler(ctx, args)).toBeNull();
    expect(
      await saveForBackend.handler(ctx, { ...args, finishedAt: 123, batch }),
    ).toBeNull();
  }
  const ctx = context();
  ctx.rows.chats.default_model_slug = "agent";
  expect(
    await saveForBackend.handler(ctx, { ...args, finishedAt: 123, batch }),
  ).toBeNull();
});
it("honors account deletion and authorization before accessing saved content", async () => {
  const ctx = context({ user_deletion_fences: { user_id: "owner" } });
  expect(await getForBackend.handler(ctx, args)).toBeNull();
  mockValidate.mockImplementationOnce(() => {
    throw new Error("Unauthorized");
  });
  await expect(getForBackend.handler(context(), args)).rejects.toThrow(
    "Unauthorized",
  );
  mockAccess.mockRejectedValueOnce(new Error("Suspended"));
  await expect(getForBackend.handler(context(), args)).rejects.toThrow(
    "Suspended",
  );
});
