import { extractSidebarContentFromMessage } from "../sidebar-utils";

describe("terminal sidebar output", () => {
  it("hides agent-only timeout guidance in fallback sidebar extraction", () => {
    const [terminal] = extractSidebarContentFromMessage({
      role: "assistant",
      parts: [
        {
          type: "tool-run_terminal_cmd",
          toolCallId: "call-timeout",
          state: "output-available",
          input: { command: "npm test", interactive: false },
          output: {
            result: {
              output:
                "Tests started.\n\nCommand output paused after 120 seconds. Command continues in terminal session f7f6fc79 (PID: 93771). Use interact_terminal_session with this exact session ID to wait, view, or kill it.",
            },
          },
        },
      ],
    });

    expect(terminal).toMatchObject({
      command: "npm test",
      output:
        "Tests started.\n\nCommand output paused after 120 seconds. Command continues in terminal session f7f6fc79 (PID: 93771).",
    });
  });

  it("hides agent-only guidance for unified shell output too", () => {
    const [terminal] = extractSidebarContentFromMessage({
      role: "assistant",
      parts: [
        {
          type: "tool-shell",
          toolCallId: "call-shell",
          state: "output-available",
          input: { action: "exec", command: "npm test" },
          output: {
            output:
              "Interactive terminal sessions are unavailable on this local connection. Use non-interactive terminal commands instead.",
          },
        },
      ],
    });

    expect(terminal).toMatchObject({
      command: "npm test",
      output:
        "Interactive terminal sessions are unavailable on this local connection.",
    });
  });

  it.each([
    "tool-shell",
    "tool-http_request",
    "tool-file",
    "tool-send_request",
    "tool-create_vulnerability_report",
  ])(
    "replaces raw %s parameter validation errors with safe details",
    (type) => {
      const [error] = extractSidebarContentFromMessage({
        role: "assistant",
        parts: [
          {
            type,
            toolCallId: `call-${type}`,
            state: "output-error",
            input: { secret: "private payload" },
            errorText:
              'Invalid input for tool example: Type validation failed: Value: {"secret":"private payload"}',
          },
        ],
      });

      expect(error).toMatchObject({
        kind: "tool-error",
        errorKind: "validation",
        toolCallId: `call-${type}`,
        isExecuting: false,
      });
      expect(JSON.stringify(error)).not.toMatch(/private payload|Value:/);
    },
  );

  it("keeps dynamic tool parameter failures visible without copying payloads", () => {
    const [error] = extractSidebarContentFromMessage({
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "custom_scanner",
          toolCallId: "dynamic-call",
          state: "output-error",
          errorText: 'Invalid tool arguments: Value: {"token":"private"}',
        },
      ],
    });

    expect(error).toMatchObject({
      kind: "tool-error",
      toolName: "Custom scanner",
      toolCallId: "dynamic-call",
    });
    expect(JSON.stringify(error)).not.toContain("private");
  });
});
