import { describe, expect, it, jest } from "@jest/globals";

const loadSaveMessageWithMocks = async () => {
  jest.resetModules();
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://example.convex.cloud";

  const mockMutation = jest.fn().mockResolvedValue({ id: "message-1" });
  const mockCompactMessageForStorage = jest.fn((message: any) => {
    const sizeBytes = JSON.stringify(message.parts).length;
    return {
      message,
      compacted: false,
      beforeSizeBytes: sizeBytes,
      afterSizeBytes: sizeBytes,
      strippedUiOnlyFields: false,
      prunedCount: 0,
    };
  });

  jest.doMock("server-only", () => ({}), { virtual: true });
  jest.doMock("convex/browser", () => ({
    ConvexHttpClient: class {
      mutation = mockMutation;
      query = jest.fn();
      action = jest.fn();
    },
  }));
  jest.doMock("@/lib/chat/compaction/prune-tool-outputs", () => ({
    compactMessageForStorage: mockCompactMessageForStorage,
  }));

  const { saveMessage } = await import("../actions");
  return { saveMessage, mockCompactMessageForStorage };
};

describe("saveMessage", () => {
  it("sanitizes assistant parts before storage compaction", async () => {
    const { saveMessage, mockCompactMessageForStorage } =
      await loadSaveMessageWithMocks();
    const circularOutput: Record<string, unknown> = { ok: true };
    circularOutput.self = circularOutput;

    await expect(
      saveMessage({
        chatId: "chat-1",
        userId: "user-1",
        message: {
          id: "message-1",
          role: "assistant",
          parts: [
            {
              type: "tool-run_terminal_cmd",
              state: "output-available",
              input: { command: "echo hi" },
              output: circularOutput,
            } as any,
          ],
        },
      }),
    ).resolves.toBeDefined();

    const compactedMessage = mockCompactMessageForStorage.mock
      .calls[0]?.[0] as {
      parts: Array<{ output?: unknown }>;
    };

    expect(compactedMessage.parts[0].output).toEqual({
      ok: true,
      self: "[Circular]",
    });
    expect(() => JSON.stringify(compactedMessage.parts)).not.toThrow();
  });
});
