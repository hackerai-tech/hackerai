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

  it("links a delegation block to its stable parent message", () => {
    const [subagents] = extractSidebarContentFromMessage({
      id: "parent-message",
      role: "assistant",
      parts: [
        {
          type: "tool-delegate_task",
          toolCallId: "delegate-1",
          state: "input-available",
          input: {},
        },
      ],
    });

    expect(subagents).toEqual({
      kind: "subagents",
      parentMessageId: "parent-message",
      toolCallId: "delegate-1",
    });
  });

  it("keeps a resumed child selected from continuation lifecycle data", () => {
    const [subagents] = extractSidebarContentFromMessage({
      id: "continuation-message",
      role: "assistant",
      parts: [
        {
          type: "tool-continue_agent",
          toolCallId: "continue-1",
          state: "output-available",
          input: {
            target_agent_id: "sa_requested",
            follow_up: "Check one more thing",
          },
          output: { success: true, agent_id: "sa_resumed" },
        },
        {
          type: "data-subagent-lifecycle",
          data: {
            subagent_id: "sa_resumed",
            parent_message_id: "original-parent-message",
            parent_tool_call_id: "continue-1",
            agent_name: "Resumed worker",
            event: "started",
            status: "queued",
          },
        },
      ],
    });

    expect(subagents).toEqual({
      kind: "subagents",
      parentMessageId: "original-parent-message",
      toolCallId: "continue-1",
      selectedSubagentId: "sa_resumed",
    });
  });

  it("keeps the resumed agent id from persisted continuation output", () => {
    const [subagents] = extractSidebarContentFromMessage({
      id: "persisted-continuation-message",
      role: "assistant",
      parts: [
        {
          type: "tool-continue_agent",
          toolCallId: "continue-persisted",
          state: "output-available",
          input: {
            target_agent_id: "sa_requested",
            follow_up: "Check one more thing",
          },
          output: { success: true, agent_id: "sa_resumed" },
        },
      ],
    });

    expect(subagents).toEqual({
      kind: "subagents",
      parentMessageId: "persisted-continuation-message",
      toolCallId: "continue-persisted",
      selectedSubagentId: "sa_resumed",
    });
  });

  it("links an update block back to the named child and its creation message", () => {
    const [subagents] = extractSidebarContentFromMessage({
      id: "update-message",
      role: "assistant",
      parts: [
        {
          type: "tool-send_message_to_agent",
          toolCallId: "send-1",
          state: "output-available",
          input: { target_agent_id: "sa_xss", message: "Use new evidence" },
          output: { success: true },
        },
        {
          type: "data-subagent-lifecycle",
          data: {
            subagent_id: "sa_xss",
            parent_message_id: "create-message",
            parent_tool_call_id: "send-1",
            agent_name: "Stored XSS validator",
            event: "updated",
            status: "running",
          },
        },
      ],
    });

    expect(subagents).toEqual({
      kind: "subagents",
      parentMessageId: "create-message",
      toolCallId: "send-1",
      selectedSubagentId: "sa_xss",
    });
  });

  it("keeps a persisted update linked to its child without lifecycle stream data", () => {
    const [subagents] = extractSidebarContentFromMessage({
      id: "later-parent-message",
      role: "assistant",
      parts: [
        {
          type: "tool-send_message_to_agent",
          toolCallId: "send-persisted",
          state: "output-available",
          input: { target_agent_id: "sa_xss", message: "Use new evidence" },
          output: {
            success: true,
            target_agent_id: "sa_xss",
            target_agent_name: "Stored XSS validator",
          },
        },
      ],
    });

    expect(subagents).toEqual({
      kind: "subagents",
      parentMessageId: "later-parent-message",
      toolCallId: "send-persisted",
      selectedSubagentId: "sa_xss",
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
