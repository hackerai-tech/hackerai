import { newObjectiveCheckpoint } from "../../lib/chat/objective-checkpoint";

jest.mock("../_generated/server", () => ({
  internalMutation: (config: unknown) => config,
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
const mockValidateServiceKey = jest.fn();
jest.mock("../lib/utils", () => ({
  validateServiceKey: (...args: unknown[]) => mockValidateServiceKey(...args),
}));
const {
  getObjectiveCheckpointForBackend,
  saveObjectiveCheckpointForBackend,
  objectiveCheckpointEnabledForChildBackend,
} = require("../subagents");
const owner = {
  serviceKey: "test-only",
  userId: "owner",
  chatId: "chat",
  triggerRunId: "parent",
};
const chat = {
  _id: "chat-row",
  id: "chat",
  user_id: "owner",
  active_trigger_run_id: "parent",
};
function context(rows: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    chats: chat,
    user_deletion_fences: null,
    ...rows,
  };
  const chain = { eq: jest.fn() };
  chain.eq.mockReturnValue(chain);
  return {
    db: {
      query: jest.fn((table: string) => ({
        withIndex: (_index: string, apply: (q: typeof chain) => void) => {
          apply(chain);
          return { first: async () => values[table] ?? null };
        },
      })),
      patch: jest.fn(async () => undefined),
    },
  };
}

it("stores a validated revision under the active owner and rejects stale writes", async () => {
  const state = { ...newObjectiveCheckpoint("parent"), revision: 1 };
  const ctx = context();
  await saveObjectiveCheckpointForBackend.handler(ctx, {
    ...owner,
    checkpoint: JSON.stringify(state),
    expectedRevision: 0,
  });
  expect(ctx.db.patch).toHaveBeenCalledWith("chat-row", {
    objective_checkpoint: JSON.stringify(state),
  });
  const stale = context({
    chats: { ...chat, objective_checkpoint: JSON.stringify(state) },
  });
  await expect(
    saveObjectiveCheckpointForBackend.handler(stale, {
      ...owner,
      checkpoint: JSON.stringify(state),
      expectedRevision: 0,
    }),
  ).rejects.toThrow("revision changed");
  expect(stale.db.patch).not.toHaveBeenCalled();
});

it.each([
  { user_id: "another-user" },
  { active_trigger_run_id: "another-run" },
  { canceled_at: 1 },
  { deletion_started_at: 1 },
])("rejects inaccessible or inactive chat selection %j", async (override) => {
  const ctx = context({ chats: { ...chat, ...override } });
  await expect(
    getObjectiveCheckpointForBackend.handler(ctx, owner),
  ).rejects.toThrow();
});

it("honors the user deletion fence and service authorization", async () => {
  const ctx = context({ user_deletion_fences: { _id: "fence" } });
  await expect(
    getObjectiveCheckpointForBackend.handler(ctx, owner),
  ).rejects.toThrow("unavailable");
  mockValidateServiceKey.mockImplementationOnce(() => {
    throw new Error("Unauthorized");
  });
  await expect(
    getObjectiveCheckpointForBackend.handler(context(), owner),
  ).rejects.toThrow("Unauthorized");
});

it("inherits the active parent assignment while preserving child ownership checks", async () => {
  const parentCheckpoint = JSON.stringify(newObjectiveCheckpoint("parent"));
  const child = {
    subagent_id: "child",
    user_id: "owner",
    chat_id: "chat",
    trigger_run_id: "child-run",
    parent_trigger_run_id: "parent",
    status: "running",
  };
  const rows = {
    chats: { ...chat, objective_checkpoint: parentCheckpoint },
    subagent_runs: child,
    subagent_work_items: { _id: "ledger", user_id: "owner" },
  };
  const childOwner = {
    ...owner,
    triggerRunId: "child-run",
    subagentId: "child",
  };
  await expect(
    objectiveCheckpointEnabledForChildBackend.handler(
      context(rows),
      childOwner,
    ),
  ).resolves.toBe(true);
  await expect(
    objectiveCheckpointEnabledForChildBackend.handler(
      context({ ...rows, subagent_runs: { ...child, status: "canceled" } }),
      childOwner,
    ),
  ).rejects.toThrow("ownership changed");
  await expect(
    objectiveCheckpointEnabledForChildBackend.handler(
      context({
        ...rows,
        chats: {
          ...chat,
          objective_checkpoint: JSON.stringify(
            newObjectiveCheckpoint("older-run"),
          ),
        },
      }),
      childOwner,
    ),
  ).resolves.toBe(false);
});

it("rejects malformed state and overlarge checkpoints before writing", async () => {
  for (const checkpoint of ["{}", "x".repeat(200_001)]) {
    const ctx = context();
    await expect(
      saveObjectiveCheckpointForBackend.handler(ctx, {
        ...owner,
        checkpoint,
        expectedRevision: 0,
      }),
    ).rejects.toThrow();
    expect(ctx.db.patch).not.toHaveBeenCalled();
  }
});
