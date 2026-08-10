import { describe, expect, it } from "@jest/globals";
import { areMessagePartHandlerPropsEqual } from "../MessagePartHandler";

const basePart = {
  type: "tool-create_agent",
  toolCallId: "tool-create-1",
  state: "output-available",
  output: { success: true, agent_id: "sa_1" },
};

const props = (parts: unknown[]) =>
  ({
    message: { id: "parent-1", role: "assistant", parts },
    part: basePart,
    partIndex: 0,
    status: "ready",
  }) as any;

describe("MessagePartHandler subagent memoization", () => {
  it("re-renders when lifecycle data arrives for an unchanged tool part", () => {
    const previous = props([basePart]);
    const next = props([
      basePart,
      {
        type: "data-subagent-lifecycle",
        data: {
          subagent_id: "sa_1",
          parent_message_id: "parent-1",
          parent_tool_call_id: "tool-create-1",
          agent_name: "XSS validator",
          event: "started",
          status: "running",
        },
      },
    ]);

    expect(areMessagePartHandlerPropsEqual(previous, next)).toBe(false);
    expect(areMessagePartHandlerPropsEqual(next, next)).toBe(true);
  });
});
