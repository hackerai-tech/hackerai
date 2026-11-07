import { expect, it, jest } from "@jest/globals";
import { syncGoalInputTiming } from "../lib/goalInputTiming";
import type { MutationCtx } from "../lib/serviceFunctions";
import { goalElapsedMs } from "../../lib/goals/timing";

it.each(["browser", "reply"])(
  "keeps Goal time frozen when %s input releases before the other input",
  async (first) => {
    const goal = {
      _id: "goal",
      userId: "user",
      activeRunId: "run",
      state: "running" as const,
      elapsedMs: 2000,
      activeSince: 1000 as number | undefined,
      updatedAt: 1000,
    };
    const chat = {
      user_id: "user",
      active_trigger_run_id: "run",
      active_agent_user_wait: { runId: "run" } as { runId: string } | undefined,
    };
    const browser = { user_id: "user", run_id: "run", state: "human" };
    const ctx = {
      db: {
        query: (table: string) => ({
          withIndex: () => {
            const first = async () =>
              table === "agent_goals"
                ? goal
                : table === "chats"
                  ? chat
                  : browser;
            return { first, order: () => ({ first }) };
          },
        }),
        patch: async (_id: string, fields: object) =>
          Object.assign(goal, fields),
      },
    } as unknown as MutationCtx;
    const identity = { userId: "user", chatId: "chat", runId: "run" };
    const now = jest.spyOn(Date, "now").mockReturnValue(4000);
    try {
      await syncGoalInputTiming(ctx, identity);
      expect(goalElapsedMs(goal, 64000)).toBe(5000);
      now.mockReturnValue(64000);
      if (first === "browser") browser.state = "agent";
      else chat.active_agent_user_wait = undefined;
      await syncGoalInputTiming(ctx, identity);
      expect(goalElapsedMs(goal, 124000)).toBe(5000);
      now.mockReturnValue(124000);
      browser.state = "agent";
      chat.active_agent_user_wait = undefined;
      await syncGoalInputTiming(ctx, identity);
      expect(goalElapsedMs(goal, 126000)).toBe(7000);
      now.mockReturnValue(125000);
      await syncGoalInputTiming(ctx, identity);
      expect(goalElapsedMs(goal, 126000)).toBe(7000);
    } finally {
      now.mockRestore();
    }
  },
);
