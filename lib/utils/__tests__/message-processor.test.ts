import { normalizeMessages } from "../message-processor";
import { INTERRUPTED_TOOL_ERROR_TEXT } from "@/lib/chat/tool-abort-utils";
import type { ChatMessage } from "@/types/chat";

describe("normalizeMessages", () => {
  it.each(["approval-requested", "approval-responded"])(
    "only settles %s tool parts when the user stops",
    (state) => {
      const pending = {
        type: "tool-file_write",
        toolCallId: "write-1",
        state,
        input: { path: "/tmp/qa.txt", text: "qa" },
        approval: { id: "approval-1", approved: true },
        providerMetadata: { provider: { signature: "test-signature" } },
      };
      const completed = {
        ...pending,
        toolCallId: "write-completed",
        state: "output-available",
        output: "File written: /tmp/qa.txt",
      };
      const messages = [
        { id: "assistant-1", role: "assistant", parts: [pending, completed] },
      ] as unknown as ChatMessage[];
      expect(normalizeMessages(messages).messages).toEqual(messages);
      const result = normalizeMessages(messages, { userInitiatedAbort: true });
      expect(result.messages[0].parts[0]).toEqual({
        ...pending,
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
