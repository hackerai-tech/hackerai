import {
  createStableChatTimelineRowsState,
  deriveChatTimelineRows,
  findLatestTimelineAnchorMessageId,
  findMessageTimelineAnchorIndex,
  stabilizeChatTimelineRows,
  type AgentActivityTimelineRow,
  type AgentToolGroupTimelineRow,
} from "../message-timeline-rows";
import type { ChatMessage } from "@/types";

const agentMessage = (
  parts: ChatMessage["parts"],
  metadata: Record<string, unknown> = {},
) =>
  ({
    id: "assistant-1",
    role: "assistant",
    parts,
    metadata: {
      mode: "agent",
      generationTimeMs: 10_000,
      ...metadata,
    },
  }) as unknown as ChatMessage;

describe("deriveChatTimelineRows", () => {
  it("keeps hidden auto-continue prompts from replacing the visible turn anchor", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Question" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Partial answer" }],
      },
      {
        id: "auto-continue-1",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { isAutoContinue: true },
      },
    ] as ChatMessage[];

    expect(findLatestTimelineAnchorMessageId(messages)).toBe("user-1");
    expect(findLatestTimelineAnchorMessageId([])).toBeNull();
  });

  it("finds the sent message row used to anchor a new turn", () => {
    const userMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Question" }],
    } as ChatMessage;
    const assistantMessage = agentMessage([
      {
        type: "tool-shell",
        toolCallId: "tool-1",
        input: { command: "pwd" },
        state: "output-available",
      },
      { type: "text", text: "Answer" },
    ] as ChatMessage["parts"]);
    const rows = deriveChatTimelineRows({
      messages: [userMessage, assistantMessage],
      status: "streaming",
      lastAssistantMessageIndex: 1,
      expandedAgentMessageIds: new Set(),
    });

    expect(findMessageTimelineAnchorIndex(rows, userMessage.id)).toBe(0);
    expect(findMessageTimelineAnchorIndex(rows, "missing")).toBeUndefined();
    expect(findMessageTimelineAnchorIndex(rows, null)).toBeUndefined();
  });

  it("creates independently virtualizable rows for every live activity", () => {
    const tools = Array.from({ length: 100 }, (_, index) => ({
      type: "tool-shell",
      toolCallId: `tool-${index}`,
      input: { command: `command ${index}` },
      state: "output-available",
    }));
    const message = agentMessage(
      [
        ...tools,
        { type: "text", text: "final answer" },
      ] as ChatMessage["parts"],
      { generationStartedAt: Date.now() },
    );

    const rows = deriveChatTimelineRows({
      messages: [message],
      status: "streaming",
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set(),
    });

    expect(rows).toHaveLength(102);
    expect(rows[0]).toMatchObject({
      kind: "agent-work-header",
      expanded: true,
      isTiming: true,
    });
    expect(rows.filter((row) => row.kind === "agent-activity")).toHaveLength(
      100,
    );
    expect(rows.at(-1)).toMatchObject({
      kind: "message",
      workPresentation: "timeline-shell",
    });
  });

  it("keeps settled activity collapsed until the user expands it", () => {
    const message = agentMessage([
      {
        type: "tool-shell",
        toolCallId: "tool-1",
        input: { command: "pwd" },
        state: "output-available",
      },
      { type: "text", text: "final answer" },
    ] as ChatMessage["parts"]);

    const collapsedRows = deriveChatTimelineRows({
      messages: [message],
      status: "ready",
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set(),
    });
    const expandedRows = deriveChatTimelineRows({
      messages: [message],
      status: "ready",
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set([message.id]),
    });

    expect(collapsedRows.map((row) => row.kind)).toEqual([
      "agent-work-header",
      "message",
    ]);
    expect(expandedRows.map((row) => row.kind)).toEqual([
      "agent-work-header",
      "agent-activity",
      "message",
    ]);
  });

  it("replaces a completed prior tool step with one animated group", () => {
    const message = agentMessage([
      { type: "step-start" },
      {
        type: "tool-read_file",
        toolCallId: "read-1",
        input: { path: "one.ts" },
        output: "contents",
        state: "output-available",
      },
      {
        type: "tool-shell",
        toolCallId: "shell-1",
        input: { command: "pwd" },
        output: "done",
        state: "output-available",
      },
      { type: "step-start" },
      { type: "reasoning", text: "Starting the next step" },
    ] as ChatMessage["parts"]);

    const rows = deriveChatTimelineRows({
      messages: [message],
      status: "streaming",
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set(),
    });
    const group = rows.find(
      (row): row is AgentToolGroupTimelineRow =>
        row.kind === "agent-tool-group",
    );

    expect(rows.map((row) => row.kind)).toEqual([
      "agent-work-header",
      "agent-tool-group",
      "agent-activity",
      "message",
    ]);
    expect(group).toMatchObject({
      animateOnMount: true,
      summary: "Read a file and ran a command",
    });
    expect(group?.activities).toHaveLength(2);
  });

  it("does not group a settled run containing a failed tool", () => {
    const message = agentMessage([
      {
        type: "tool-read_file",
        toolCallId: "read-1",
        state: "output-available",
      },
      {
        type: "tool-shell",
        toolCallId: "shell-1",
        state: "output-error",
        errorText: "command failed",
      },
    ] as ChatMessage["parts"]);

    const rows = deriveChatTimelineRows({
      messages: [message],
      status: "ready",
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set(),
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "agent-work-header",
      "agent-activity",
      "agent-activity",
      "message",
    ]);
  });

  it("keeps reasoning-only activity reachable from the settled header", () => {
    const message = agentMessage([
      { type: "reasoning", text: "analysis" },
      { type: "text", text: "final answer" },
    ] as ChatMessage["parts"]);

    const collapsedRows = deriveChatTimelineRows({
      messages: [message],
      status: "ready",
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set(),
    });
    const expandedRows = deriveChatTimelineRows({
      messages: [message],
      status: "ready",
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set([message.id]),
    });

    expect(collapsedRows[0]).toMatchObject({
      kind: "agent-work-header",
      canToggle: true,
      expanded: false,
    });
    expect(expandedRows.map((row) => row.kind)).toEqual([
      "agent-work-header",
      "agent-activity",
      "message",
    ]);
  });

  it("merges tool lifecycle snapshots and terminal chunks into their logical row", () => {
    const message = agentMessage([
      {
        type: "tool-shell",
        toolCallId: "tool-1",
        input: { command: "long command" },
        state: "input-available",
      },
      {
        type: "data-terminal",
        data: { toolCallId: "tool-1", terminal: "first " },
      },
      {
        type: "data-terminal",
        data: { toolCallId: "tool-1", terminal: "second" },
      },
      {
        type: "tool-shell",
        toolCallId: "tool-1",
        input: { command: "long command" },
        output: "done",
        state: "output-available",
      },
    ] as ChatMessage["parts"]);

    const rows = deriveChatTimelineRows({
      messages: [message],
      status: "ready",
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set(),
    });
    const activityRows = rows.filter(
      (row): row is AgentActivityTimelineRow => row.kind === "agent-activity",
    );

    expect(activityRows).toHaveLength(1);
    expect(activityRows[0].part).toMatchObject({
      toolCallId: "tool-1",
      output: "done",
      state: "output-available",
    });
    expect(activityRows[0].terminalChunksByToolCallId.get("tool-1")).toEqual([
      "first ",
      "second",
    ]);
  });

  it("projects a contiguous reasoning stream as one logical activity", () => {
    const message = agentMessage([
      { type: "reasoning", text: "first" },
      { type: "reasoning", text: "second" },
      {
        type: "tool-shell",
        toolCallId: "tool-1",
        input: { command: "pwd" },
        state: "output-available",
      },
    ] as ChatMessage["parts"]);

    const rows = deriveChatTimelineRows({
      messages: [message],
      status: "ready",
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set(),
    });

    expect(rows.filter((row) => row.kind === "agent-activity")).toHaveLength(2);
  });

  it("reuses every row when derivation produces equivalent data", () => {
    const message = agentMessage([
      {
        type: "tool-shell",
        toolCallId: "tool-1",
        input: { command: "pwd" },
        state: "output-available",
      },
    ] as ChatMessage["parts"]);
    const options = {
      messages: [message],
      status: "ready" as const,
      lastAssistantMessageIndex: 0,
      expandedAgentMessageIds: new Set<string>(),
    };

    const first = stabilizeChatTimelineRows(
      deriveChatTimelineRows(options),
      createStableChatTimelineRowsState(),
    );
    const second = stabilizeChatTimelineRows(
      deriveChatTimelineRows(options),
      first,
    );

    expect(second).toBe(first);
    expect(second.result).toBe(first.result);
  });

  it("keeps settled rows stable while the active message changes", () => {
    const userMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "question" }],
    } as ChatMessage;
    const firstAssistant = agentMessage([
      { type: "text", text: "first chunk" },
    ] as ChatMessage["parts"]);
    const nextAssistant = {
      ...firstAssistant,
      parts: [{ type: "text", text: "first chunk plus more" }],
    } as ChatMessage;
    const derive = (assistant: ChatMessage) =>
      deriveChatTimelineRows({
        messages: [userMessage, assistant],
        status: "streaming",
        lastAssistantMessageIndex: 1,
        expandedAgentMessageIds: new Set(),
      });

    const first = stabilizeChatTimelineRows(
      derive(firstAssistant),
      createStableChatTimelineRowsState(),
    );
    const second = stabilizeChatTimelineRows(derive(nextAssistant), first);

    expect(second.result[0]).toBe(first.result[0]);
    expect(second.result.at(-1)).not.toBe(first.result.at(-1));
  });
});
