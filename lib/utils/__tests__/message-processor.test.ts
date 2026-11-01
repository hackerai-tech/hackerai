import { normalizeMessages } from "../message-processor";
import {
  ABORTED_TOOL_ERROR_TEXT,
  INTERRUPTED_TOOL_ERROR_TEXT,
} from "@/lib/chat/tool-abort-utils";
import type { ChatMessage } from "@/types/chat";

describe("normalizeMessages", () => {
  it.each([
    "tool-run_terminal_cmd",
    "tool-interact_terminal_session",
    "tool-shell",
    "tool-file",
  ])(
    "settles stopped approvals for %s without retaining approval authority",
    (type) => {
      for (const state of ["approval-requested", "approval-responded"]) {
        const part = {
          type,
          toolCallId: "awaiting-tool",
          state,
          input: { command: "printf approval-test" },
          approval: { id: "approval-1", approved: true },
          callProviderMetadata: {
            google: { thoughtSignature: "signed-call-fixture" },
          },
          providerExecuted: false,
        };
        const messages = [
          { id: "assistant-1", role: "assistant", parts: [part] },
        ] as unknown as ChatMessage[];

        // Merely preparing messages does not cancel a live approval.
        expect(normalizeMessages(messages).messages[0].parts[0]).toBe(part);
        const result = normalizeMessages(messages, {
          userInitiatedAbort: true,
        });
        expect(result.hasChanges).toBe(true);
        expect(result.messages[0].parts[0]).toMatchObject({
          type,
          toolCallId: "awaiting-tool",
          state: "output-error",
          input: part.input,
          callProviderMetadata: part.callProviderMetadata,
          providerExecuted: false,
          errorText: ABORTED_TOOL_ERROR_TEXT,
        });
        expect(result.messages[0].parts[0]).not.toHaveProperty("approval");
        expect(part.approval).toEqual({ id: "approval-1", approved: true });
      }
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
