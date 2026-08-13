import { extractSidebarContentFromMessage } from "../sidebar-utils";

describe("terminal sidebar output", () => {
  it("shows the generated command while automatic review is still pending", () => {
    const startedAt = Date.now();
    const [terminal] = extractSidebarContentFromMessage({
      role: "assistant",
      parts: [
        {
          type: "tool-shell",
          toolCallId: "call-reviewing",
          state: "input-available",
          input: {
            action: "exec",
            command: "wafw00f https://hackerone.com",
          },
        },
        {
          type: "data-agent-auto-review-lifecycle",
          data: {
            approvalId: "approval-1",
            toolCallId: "call-reviewing",
            status: "reviewing",
            startedAt,
          },
        },
      ],
    });

    expect(terminal).toMatchObject({
      command: "wafw00f https://hackerone.com",
      executionPhase: "reviewing",
      isExecuting: false,
    });
  });

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
});

describe("web search sidebar output", () => {
  it("falls back to the legacy query when queries has an invalid shape", () => {
    const [webSearch] = extractSidebarContentFromMessage({
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "call-search",
          state: "input-available",
          input: {
            queries: { 0: "unexpected", length: 1 },
            query: "fallback sidebar query",
          },
        },
      ],
    });

    expect(webSearch).toMatchObject({
      query: "fallback sidebar query",
      isSearching: true,
      toolCallId: "call-search",
    });
  });
});
