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

  it("omits the pending empty Agent row until visible work arrives", () => {
    const userMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Question" }],
    } as ChatMessage;
    const emptyAssistantMessage = agentMessage([]);

    const pendingStatuses = ["submitted", "streaming"] as const;
    const pendingRowsByStatus = pendingStatuses.map((status) =>
      deriveChatTimelineRows({
        messages: [userMessage, emptyAssistantMessage],
        status,
        lastAssistantMessageIndex: 1,
        expandedAgentMessageIds: new Set(),
      }),
    );
    const activeRows = deriveChatTimelineRows({
      messages: [
        userMessage,
        {
          ...emptyAssistantMessage,
          parts: [{ type: "reasoning", text: "Starting" }],
        } as ChatMessage,
      ],
      status: "streaming",
      lastAssistantMessageIndex: 1,
      expandedAgentMessageIds: new Set(),
    });

    for (const pendingRows of pendingRowsByStatus) {
      expect(pendingRows.map((row) => row.id)).toEqual([
        `message:${userMessage.id}`,
      ]);
    }
    expect(activeRows.map((row) => row.kind)).toEqual([
      "message",
      "agent-work-header",
      "agent-activity",
      "message",
    ]);
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
      summary: "Read a file, ran a command",
    });
    expect(group?.activities).toHaveLength(2);
  });

  it("animates only tool groups introduced after the initial timeline commit", () => {
    const message = agentMessage([
      { type: "step-start" },
      {
        type: "tool-read_file",
        toolCallId: "read-1",
        state: "output-available",
      },
      {
        type: "tool-shell",
        toolCallId: "shell-1",
        state: "output-available",
      },
      { type: "step-start" },
      { type: "reasoning", text: "Next step" },
    ] as ChatMessage["parts"]);
    const deriveGroup = (
      animateNewToolGroups: boolean,
      seenToolGroupIds = new Set<string>(),
      seenAgentMessageIds: ReadonlySet<string> | undefined = undefined,
      restoredAgentMessageIds = new Set<string>(),
    ) =>
      deriveChatTimelineRows({
        messages: [message],
        status: "streaming",
        lastAssistantMessageIndex: 0,
        expandedAgentMessageIds: new Set(),
        animateNewToolGroups,
        seenAgentMessageIds,
        seenToolGroupIds,
        restoredAgentMessageIds,
      }).find((row) => row.kind === "agent-tool-group");

    const initialGroup = deriveGroup(false);
    expect(initialGroup).toMatchObject({ animateOnMount: false });

    const hydratedGroup = deriveGroup(true, new Set(), new Set());
    expect(hydratedGroup).toMatchObject({ animateOnMount: false });

    const liveGroup = deriveGroup(true, new Set(), new Set([message.id]));
    expect(liveGroup).toMatchObject({ animateOnMount: true });

    const restoredGroup = deriveGroup(
      true,
      new Set(),
      new Set([message.id]),
      new Set([message.id]),
    );
    expect(restoredGroup).toMatchObject({ animateOnMount: false });

    const seenGroup = deriveGroup(
      true,
      new Set([liveGroup?.id ?? ""]),
      new Set([message.id]),
    );
    expect(seenGroup).toMatchObject({ animateOnMount: false });
  });

  it("groups a settled run containing a failed tool", () => {
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
      "agent-tool-group",
      "message",
    ]);
    expect(rows.find((row) => row.kind === "agent-tool-group")).toMatchObject({
      summary: "Read a file, ran a command",
      activities: expect.arrayContaining([
        expect.objectContaining({ id: "tool:shell-1" }),
      ]),
    });
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

  it("stabilizes an unchanged completed tool group", () => {
    const message = agentMessage([
      {
        type: "tool-read_file",
        toolCallId: "read-1",
        state: "output-available",
      },
      {
        type: "tool-shell",
        toolCallId: "shell-1",
        state: "output-available",
      },
    ] as ChatMessage["parts"]);
    const derive = (nextMessage: ChatMessage) =>
      deriveChatTimelineRows({
        messages: [nextMessage],
        status: "ready",
        lastAssistantMessageIndex: 0,
        expandedAgentMessageIds: new Set(),
      });

    const first = stabilizeChatTimelineRows(
      derive(message),
      createStableChatTimelineRowsState(),
    );
    const second = stabilizeChatTimelineRows(derive(message), first);
    const firstGroup = first.result.find(
      (row) => row.kind === "agent-tool-group",
    );
    const secondGroup = second.result.find(
      (row) => row.kind === "agent-tool-group",
    );

    expect(firstGroup).toBeDefined();
    expect(secondGroup).toBe(firstGroup);
  });

  it("replaces a stabilized tool group when an activity changes", () => {
    const message = agentMessage([
      {
        type: "tool-read_file",
        toolCallId: "read-1",
        output: "first",
        state: "output-available",
      },
      {
        type: "tool-shell",
        toolCallId: "shell-1",
        state: "output-available",
      },
    ] as ChatMessage["parts"]);
    const changedMessage = {
      ...message,
      parts: message.parts.map((part) =>
        (part as { toolCallId?: string }).toolCallId === "read-1"
          ? { ...part, output: "changed" }
          : part,
      ),
    } as ChatMessage;
    const derive = (nextMessage: ChatMessage) =>
      deriveChatTimelineRows({
        messages: [nextMessage],
        status: "ready",
        lastAssistantMessageIndex: 0,
        expandedAgentMessageIds: new Set(),
      });

    const first = stabilizeChatTimelineRows(
      derive(message),
      createStableChatTimelineRowsState(),
    );
    const second = stabilizeChatTimelineRows(derive(changedMessage), first);

    expect(
      second.result.find((row) => row.kind === "agent-tool-group"),
    ).not.toBe(first.result.find((row) => row.kind === "agent-tool-group"));
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
