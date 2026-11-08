import { describe, expect, it } from "@jest/globals";
import { getSidebarChatStatus } from "../sidebar-chat-status";

describe("sidebar chat attention", () => {
  it.each([
    [{ active_agent_approval_pending: true }, "approval"],
    [{ active_agent_user_wait: { status: "waiting" as const } }, "reply"],
    [{ goal_needs_input: true }, "goal"],
    [{ browser_needs_input: true }, "browser"],
  ])("shows %s as needing input", (fields, reason) => {
    expect(
      getSidebarChatStatus({ ...fields, active_trigger_run_id: "run-1" }),
    ).toEqual({ needsInputReason: reason, isStreaming: false });
  });

  it("returns to working when a user reply is submitting", () => {
    expect(
      getSidebarChatStatus({
        active_agent_user_wait: { status: "submitting" },
        active_trigger_run_id: "run-1",
      }),
    ).toEqual({ needsInputReason: undefined, isStreaming: true });
  });

  it("prioritizes approvals over other input requests", () => {
    expect(
      getSidebarChatStatus({
        active_agent_approval_pending: true,
        active_agent_user_wait: { status: "waiting" },
        goal_needs_input: true,
      }).needsInputReason,
    ).toBe("approval");
  });

  it("clears attention after terminal cleanup", () => {
    expect(getSidebarChatStatus({})).toEqual({
      needsInputReason: undefined,
      isStreaming: false,
    });
  });
});
