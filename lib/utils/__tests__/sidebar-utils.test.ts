import {
  extractSidebarContentFromMessage,
  isSameSidebarContent,
  reconcileSidebarContentAfterRegeneration,
} from "../sidebar-utils";
import type { SidebarContent } from "@/types/chat";

describe("terminal sidebar output", () => {
  it.each([
    [
      "tool-run_terminal_cmd",
      { command: 'sh -c "exit 7"' },
      { result: { exitCode: 7 } },
    ],
    [
      "tool-interact_terminal_session",
      { action: "wait", session: "qa" },
      { result: { exited: { exitCode: 7 } } },
    ],
    ["tool-shell", { action: "exec", command: "false" }, { exitCode: 7 }],
  ])(
    "retains the exit code when rebuilding %s from history",
    (type, input, output) => {
      const [terminal] = extractSidebarContentFromMessage({
        role: "assistant",
        parts: [
          {
            type,
            input,
            output,
            toolCallId: "call-exit7",
            state: "output-available",
          },
        ],
      });

      expect(terminal).toMatchObject({ exitCode: 7, isExecuting: false });
    },
  );

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

  it.each([
    "tool-shell",
    "tool-http_request",
    "tool-file",
    "tool-send_request",
    "tool-create_vulnerability_report",
    "tool-list_reports",
    "tool-get_report",
    "tool-update_vulnerability_report",
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

  it.each([
    { state: "output-error", errorText: "private transport failure" },
    {
      state: "output-available",
      output: { success: false, error: "general", message: "private failure" },
    },
    {
      state: "output-available",
      output: { result: { success: false, error: "chat_not_found" } },
    },
    {
      state: "output-available",
      output: { success: true, finding_id: "incomplete" },
    },
  ])(
    "retains synthesized finding errors for sidebar navigation: %j",
    (part) => {
      const contents = extractSidebarContentFromMessage({
        role: "assistant",
        parts: [
          {
            type: "tool-create_vulnerability_report",
            toolCallId: "finding-failure",
            ...part,
          },
        ],
      });
      expect(contents).toHaveLength(1);
      expect(contents[0]).toMatchObject({
        kind: "tool-error",
        toolCallId: "finding-failure",
        isExecuting: false,
      });
      expect(JSON.stringify(contents)).not.toContain("private");
    },
  );

  it("does not offer sidebar details for duplicate finding rejections", () => {
    expect(
      extractSidebarContentFromMessage({
        role: "assistant",
        parts: [
          {
            type: "tool-create_vulnerability_report",
            toolCallId: "duplicate",
            state: "output-available",
            output: { success: false, error: "duplicate" },
          },
        ],
      }),
    ).toEqual([]);
  });

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

describe("report tool sidebar history", () => {
  const report = {
    finding_id: "finding-1",
    title: "Saved finding",
    target: "authorized lab",
    severity: "medium",
    cvss_score: 5.3,
    updated_at: 123,
  };
  it.each(["tool-get_report", "tool-update_vulnerability_report"])(
    "retains %s receipts without copying private proof",
    (type) => {
      const output =
        type === "tool-get_report"
          ? { success: true, report: { ...report, evidence: "private proof" } }
          : { success: true, ...report };
      const message = {
        role: "assistant",
        parts: [
          {
            type,
            toolCallId: "report-call",
            state: "output-available",
            output,
          },
        ],
      };
      const contents = extractSidebarContentFromMessage(message);
      expect(contents).toEqual([
        {
          findingId: "finding-1",
          title: "Saved finding",
          target: "authorized lab",
          severity: "medium",
          cvssScore: 5.3,
          isExecuting: false,
          toolCallId: "report-call",
        },
      ]);
      expect(JSON.stringify(contents)).not.toContain("private proof");
      expect(
        extractSidebarContentFromMessage(JSON.parse(JSON.stringify(message))),
      ).toEqual(contents);
    },
  );
  it.each([
    "tool-list_reports",
    "tool-get_report",
    "tool-update_vulnerability_report",
  ])("retains safe %s failures for sidebar navigation", (type) => {
    const contents = extractSidebarContentFromMessage({
      role: "assistant",
      parts: [
        {
          type,
          toolCallId: "report-failure",
          state: "output-available",
          output: {
            success: false,
            error: "conflict",
            message: "private proof",
          },
        },
      ],
    });
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({
      kind: "tool-error",
      toolCallId: "report-failure",
      isExecuting: false,
    });
    expect(JSON.stringify(contents)).not.toContain("private proof");
  });
  it("does not add successful metadata lists or pending calls to sidebar navigation", () => {
    expect(
      extractSidebarContentFromMessage({
        role: "assistant",
        parts: [
          {
            type: "tool-list_reports",
            state: "output-available",
            output: { success: true, reports: [report] },
          },
          {
            type: "tool-get_report",
            state: "input-available",
            input: { finding_id: "finding-1" },
          },
        ],
      }),
    ).toEqual([]);
  });
  it("does not claim a malformed success is a saved report", () => {
    const [content] = extractSidebarContentFromMessage({
      role: "assistant",
      parts: [
        {
          type: "tool-get_report",
          toolCallId: "malformed",
          state: "output-available",
          output: { success: true },
        },
      ],
    });
    expect(content).toMatchObject({
      kind: "tool-error",
      toolCallId: "malformed",
    });
  });
});

describe("subagent sidebar reconciliation after regeneration", () => {
  const parentMessage = {
    id: "parent-message",
    role: "assistant",
    parts: [
      {
        type: "tool-create_agent",
        toolCallId: "create-agent",
        state: "output-available",
        input: { task: "Check fixture" },
        output: { agent_id: "child-agent" },
      },
    ],
  };
  const childSelection: SidebarContent = {
    command: "pwd",
    output: "/tmp",
    isExecuting: false,
    toolCallId: "child-tool",
    origin: {
      kind: "subagent",
      subagentId: "child-agent",
      returnContent: {
        kind: "subagents",
        parentMessageId: "parent-message",
        toolCallId: "create-agent",
      },
    },
  };

  it("preserves a child output when its parent tool survives", () => {
    expect(
      reconcileSidebarContentAfterRegeneration([parentMessage], childSelection),
    ).toBe(childSelection);
  });

  it("clears a child output when its parent response is discarded", () => {
    expect(
      reconcileSidebarContentAfterRegeneration([], childSelection),
    ).toBeNull();
  });
});

describe("finding sidebar selection identity", () => {
  const receipt: SidebarContent = {
    findingId: "finding-1",
    title: "Saved finding",
    target: "authorized lab",
    severity: "medium",
    cvssScore: 5.3,
    isExecuting: false,
    toolCallId: "report-call",
  };

  it("matches a finding opened without a tool receipt", () => {
    expect(isSameSidebarContent(receipt, { ...receipt, toolCallId: "" })).toBe(
      true,
    );
  });

  it("does not match a discarded tool receipt for the same finding", () => {
    expect(
      isSameSidebarContent(receipt, {
        ...receipt,
        toolCallId: "discarded-call",
      }),
    ).toBe(false);
  });
});

describe.each(["tool-file", "tool-file_write"])(
  "file sidebar compatibility: %s",
  (type) => {
    it.each(["write", "append"])(
      "retains streaming and saved %s content",
      (action) => {
        const call = {
          type,
          toolCallId: "file-content",
          input: { action, path: "/project/notes.txt", text: "new content\n" },
        };
        const [streaming] = extractSidebarContentFromMessage({
          role: "assistant",
          parts: [{ ...call, state: "input-streaming" }],
        });
        expect(streaming).toMatchObject({
          path: "/project/notes.txt",
          content: "new content\n",
          action: action === "write" ? "creating" : "appending",
          toolCallId: "file-content",
          isExecuting: true,
        });
        const [saved] = extractSidebarContentFromMessage({
          role: "assistant",
          parts: [
            {
              ...call,
              state: "output-available",
              output:
                action === "append"
                  ? { originalContent: "existing\n" }
                  : { success: true },
            },
          ],
        });
        expect(saved).toMatchObject({
          path: "/project/notes.txt",
          content:
            action === "write" ? "new content\n" : "existing\nnew content\n",
          action: action === "write" ? "writing" : "appending",
          toolCallId: "file-content",
          isExecuting: false,
        });
      },
    );
  },
);

it("shows a dedicated edit in the sidebar without an action argument", () => {
  const call = {
    type: "tool-file_edit",
    toolCallId: "edit-content",
    input: {
      path: "/project/notes.txt",
      edits: [{ find: "old", replace: "new" }],
    },
  };
  const [pending] = extractSidebarContentFromMessage({
    role: "assistant",
    parts: [{ ...call, state: "input-available" }],
  });
  expect(pending).toMatchObject({
    path: "/project/notes.txt",
    action: "editing",
    isExecuting: true,
  });
  const [saved] = extractSidebarContentFromMessage({
    role: "assistant",
    parts: [
      {
        ...call,
        state: "output-available",
        output: { originalContent: "old", modifiedContent: "new" },
      },
    ],
  });
  expect(saved).toMatchObject({
    path: "/project/notes.txt",
    content: "new",
    action: "editing",
    isExecuting: false,
  });
});
