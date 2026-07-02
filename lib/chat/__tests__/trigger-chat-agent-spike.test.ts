import {
  isTriggerChatAgentSpikeEnabled,
  TRIGGER_CHAT_AGENT_SPIKE_ENV,
} from "../trigger-chat-agent-spike";

describe("Trigger chat.agent spike flag", () => {
  test("is disabled by default", () => {
    expect(isTriggerChatAgentSpikeEnabled({})).toBe(false);
  });

  test("accepts explicit opt-in values", () => {
    for (const value of ["1", "true", "YES", "on"]) {
      expect(
        isTriggerChatAgentSpikeEnabled({
          [TRIGGER_CHAT_AGENT_SPIKE_ENV]: value,
        }),
      ).toBe(true);
    }
  });

  test("rejects non opt-in values", () => {
    for (const value of ["0", "false", "off", ""]) {
      expect(
        isTriggerChatAgentSpikeEnabled({
          [TRIGGER_CHAT_AGENT_SPIKE_ENV]: value,
        }),
      ).toBe(false);
    }
  });
});
