import { describe, expect, it } from "@jest/globals";
import {
  TRIGGER_CHAT_HEARTBEAT_INTERVAL_MS,
  TRIGGER_CHAT_HEARTBEAT_PART_TYPE,
  stripTriggerChatHeartbeatParts,
  stripTriggerChatHeartbeatPartsFromMessages,
} from "../trigger-chat-heartbeat";

describe("trigger-chat heartbeat helpers", () => {
  it("uses a heartbeat interval below the 300 second quiet window", () => {
    expect(TRIGGER_CHAT_HEARTBEAT_INTERVAL_MS).toBeLessThan(300_000);
  });

  it("strips heartbeat parts without touching visible parts", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: TRIGGER_CHAT_HEARTBEAT_PART_TYPE, data: { at: 1 } },
        { type: "data-terminal", data: { terminal: "done", toolCallId: "t1" } },
      ],
    };

    expect(stripTriggerChatHeartbeatParts(message)).toEqual({
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

    expect(stripTriggerChatHeartbeatPartsFromMessages(messages)).toBe(messages);
  });
});
