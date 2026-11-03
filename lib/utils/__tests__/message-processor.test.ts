import { normalizeMessages } from "../message-processor";
import { INTERRUPTED_TOOL_ERROR_TEXT } from "@/lib/chat/tool-abort-utils";
import type { ChatMessage } from "@/types/chat";
import { convertToModelMessages, validateUIMessages } from "ai";

describe("normalizeMessages", () => {
  it.each(["approval-requested", "approval-responded"])(
    "only settles %s tool parts when the user stops",
    async (state) => {
      const pending = {
        type: "tool-file_write",
        toolCallId: "write-1",
        state,
        input: { path: "/tmp/qa.txt", text: "qa" },
        approval: {
          id: "approval-1",
          ...(state === "approval-responded" ? { approved: true } : {}),
        },
        providerMetadata: { provider: { signature: "test-signature" } },
      };
      const completed = {
        ...pending,
        toolCallId: "write-completed",
        state: "output-available",
        approval: undefined,
        output: "File written: /tmp/qa.txt",
      };
      const messages = [
        { id: "assistant-1", role: "assistant", parts: [pending, completed] },
      ] as unknown as ChatMessage[];
      expect(normalizeMessages(messages).messages).toEqual(messages);
      const result = normalizeMessages(messages, { userInitiatedAbort: true });
      await expect(
        validateUIMessages({ messages: result.messages }),
      ).resolves.toBeDefined();
      const modelMessages = await convertToModelMessages(result.messages);
      const modelParts = modelMessages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      expect(
        modelParts.some(
          (part) =>
            part.type === "tool-approval-request" ||
            part.type === "tool-approval-response",
        ),
      ).toBe(false);
      expect(modelParts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool-call",
            toolCallId: "write-1",
            input: pending.input,
          }),
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "write-1",
            output: expect.objectContaining({
              type: "error-text",
              value: "Stopped by user before the tool completed.",
            }),
          }),
        ]),
      );
      const { approval: _approval, ...stopped } = pending;
      expect(result.messages[0].parts[0]).toEqual({
        ...stopped,
        state: "output-error",
        errorText: "Stopped by user before the tool completed.",
      });
      expect(result.messages[0].parts[1]).toBe(completed);
      expect(pending.state).toBe(state);
    },
  );

  it.each([
    [
      "tool-shell",
      { action: "exec", command: "sleep 60", brief: "Running check" },
    ],
    ["tool-run_terminal_cmd", { command: "sleep 60" }],
    ["tool-interact_terminal_session", { command: "\u0003" }],
  ])("marks an interrupted %s invocation as stopped", (type, input) => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Run a harmless long command" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type,
            toolCallId: "tool-1",
            state: "input-available",
            input,
          },
          {
            type: "data-terminal",
            data: { toolCallId: "tool-1", terminal: "partial output\n" },
          },
        ],
      },
    ] as unknown as ChatMessage[];

    const result = normalizeMessages(messages);
    const terminalPart = result.messages[1].parts[0] as {
      type: string;
      state: string;
      errorText?: string;
      output?: { output?: string; result?: { stdout?: string } };
    };

    expect(result.hasChanges).toBe(true);
    expect(terminalPart.type).toBe(type);
    expect(terminalPart.state).toBe("output-error");
    expect(terminalPart.errorText).toBe(INTERRUPTED_TOOL_ERROR_TEXT);
    expect(
      terminalPart.output?.output ?? terminalPart.output?.result?.stdout,
    ).toBe("partial output\n");
    expect(result.messages[1].parts).toHaveLength(1);
  });
});
