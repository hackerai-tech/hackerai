import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import {
  createAgentRunCorrelationToken,
  verifyAgentRunCorrelationToken,
} from "@/lib/api/agent-run-correlation";

const TEST_SECRET = "test-agent-run-correlation-secret";
const originalSecret = process.env.AGENT_RUN_CORRELATION_SECRET;

describe("Agent run correlation tokens", () => {
  beforeEach(() => {
    process.env.AGENT_RUN_CORRELATION_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.AGENT_RUN_CORRELATION_SECRET;
    } else {
      process.env.AGENT_RUN_CORRELATION_SECRET = originalSecret;
    }
  });

  it("verifies a token bound to the same user, chat, and Trigger run", () => {
    const binding = {
      userId: "user-1",
      chatId: "chat-1",
      runId: "run-1",
    };
    const token = createAgentRunCorrelationToken(binding);

    expect(verifyAgentRunCorrelationToken({ ...binding, token })).toBe(true);
  });

  it.each([
    { userId: "user-2", chatId: "chat-1", runId: "run-1" },
    { userId: "user-1", chatId: "chat-2", runId: "run-1" },
    { userId: "user-1", chatId: "chat-1", runId: "run-2" },
  ])("rejects a token when its binding is changed", (binding) => {
    const token = createAgentRunCorrelationToken({
      userId: "user-1",
      chatId: "chat-1",
      runId: "run-1",
    });

    expect(verifyAgentRunCorrelationToken({ ...binding, token })).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(
      verifyAgentRunCorrelationToken({
        userId: "user-1",
        chatId: "chat-1",
        runId: "run-1",
        token: "not-a-signed-token",
      }),
    ).toBe(false);
  });
});
