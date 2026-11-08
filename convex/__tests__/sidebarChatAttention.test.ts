import { describe, expect, it, jest } from "@jest/globals";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../lib/serviceFunctions";
import { getSidebarChatAttention } from "../lib/sidebarChatAttention";

function makeContext(goal: unknown, browser: unknown): QueryCtx {
  return {
    db: {
      query: jest.fn((table: string) => ({
        withIndex: jest.fn(() => ({
          unique: jest.fn(async () => (table === "agent_goals" ? goal : null)),
          order: jest.fn(() => ({
            first: jest.fn(async () =>
              table === "browser_handoffs" ? browser : null,
            ),
          })),
        })),
      })),
    },
  } as unknown as QueryCtx;
}

const chat = {
  id: "chat-1",
  user_id: "user-1",
  active_trigger_run_id: "run-1",
} as Doc<"chats">;

describe("sidebar attention read model", () => {
  it("shows a goal question and current browser handoff", async () => {
    const now = Date.now();
    const [result] = await getSidebarChatAttention(
      makeContext(
        { userId: "user-1", state: "needs_input" },
        {
          user_id: "user-1",
          run_id: "run-1",
          state: "waiting",
          expires_at: now + 60_000,
        },
      ),
      [chat],
    );
    expect(result).toEqual({
      goal_needs_input: true,
      browser_needs_input: true,
    });
  });

  it("ignores old browser sessions and deleted goals", async () => {
    const [result] = await getSidebarChatAttention(
      makeContext(
        { userId: "user-1", state: "needs_input", deletedAt: Date.now() },
        {
          user_id: "user-1",
          run_id: "previous-run",
          state: "waiting",
          expires_at: Date.now() + 60_000,
        },
      ),
      [chat],
    );
    expect(result).toEqual({
      goal_needs_input: false,
      browser_needs_input: false,
    });
  });

  it("shows browser recovery when a control grant has expired", async () => {
    const [result] = await getSidebarChatAttention(
      makeContext(null, {
        user_id: "user-1",
        run_id: "run-1",
        state: "human",
        grant_expires_at: Date.now() - 1,
        expires_at: Date.now() + 60_000,
      }),
      [chat],
    );
    expect(result.browser_needs_input).toBe(true);
  });
});
