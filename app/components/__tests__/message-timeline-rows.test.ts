import {
  deriveChatTimelineRows,
  type AgentActivityTimelineRow,
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
});
