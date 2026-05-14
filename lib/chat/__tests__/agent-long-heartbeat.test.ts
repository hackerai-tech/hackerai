import { describe, expect, it } from "@jest/globals";
import {
  AGENT_LONG_HEARTBEAT_INTERVAL_MS,
  AGENT_LONG_HEARTBEAT_PART_TYPE,
  stripAgentLongHeartbeatParts,
  stripAgentLongHeartbeatPartsFromMessages,
} from "../agent-long-heartbeat";

describe("agent-long heartbeat helpers", () => {
  it("uses a heartbeat interval below the 300 second quiet window", () => {
    expect(AGENT_LONG_HEARTBEAT_INTERVAL_MS).toBeLessThan(300_000);
  });

  it("strips heartbeat parts without touching visible parts", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: AGENT_LONG_HEARTBEAT_PART_TYPE, data: { at: 1 } },
        { type: "data-terminal", data: { terminal: "done", toolCallId: "t1" } },
      ],
    };

    expect(stripAgentLongHeartbeatParts(message)).toEqual({
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "data-terminal", data: { terminal: "done", toolCallId: "t1" } },
      ],
    });
  });

  it("returns the original array when no heartbeat parts are present", () => {
    const messages = [{ parts: [{ type: "text", text: "hello" }] }];

    expect(stripAgentLongHeartbeatPartsFromMessages(messages)).toBe(messages);
  });
});
