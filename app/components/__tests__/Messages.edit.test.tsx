import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useLayoutEffect } from "react";
import type { ReactNode } from "react";
import {
  DataStreamProvider,
  useDataStreamDispatch,
} from "../DataStreamProvider";
import { Messages } from "../Messages";
import type { ChatMessage } from "@/types";
import { mockLegendListScrollToIndex } from "../../../__mocks__/@legendapp/list-react";

jest.mock("../MessageItem", () => ({
  MessageItem: ({
    canEdit,
    isEditing,
    message,
    onStartEdit,
    status,
  }: {
    canEdit: boolean;
    isEditing: boolean;
    message: ChatMessage;
    onStartEdit: (messageId: string) => void;
    status: string;
  }) => (
    <div data-testid={`message-${message.id}`} data-status={status}>
      {isEditing ? (
        <div data-testid="message-editor">Editing {message.id}</div>
      ) : canEdit ? (
        <button
          type="button"
          aria-label="Edit message"
          onClick={() => onStartEdit(message.id)}
        >
          Edit
        </button>
      ) : null}
    </div>
  ),
}));

jest.mock("../AgentActivityRow", () => ({
  AgentActivityRow: ({
    suppressReasoningAutoOpen,
  }: {
    suppressReasoningAutoOpen: boolean;
  }) => (
    <div
      data-testid="agent-activity-row"
      data-suppress-reasoning-auto-open={suppressReasoningAutoOpen}
    />
  ),
}));

jest.mock("../AgentWorkHeader", () => ({
  AgentWorkHeader: () => null,
}));

jest.mock("../../hooks/useFileUrlCache", () => ({
  useFileUrlCache: () => ({
    getCachedUrl: jest.fn(),
    setCachedUrl: jest.fn(),
  }),
}));

jest.mock("../../hooks/useFeedback", () => ({
  useFeedback: () => ({
    feedbackInputMessageId: null,
    handleFeedback: jest.fn(),
    handleFeedbackSubmit: jest.fn(),
    handleFeedbackCancel: jest.fn(),
  }),
}));

const messages = [
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Question" }],
  },
  {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Answer" }],
  },
] as ChatMessage[];

const navigatorMessages = [
  ...messages,
  {
    id: "user-2",
    role: "user",
    parts: [{ type: "text", text: "Follow-up question" }],
  },
  {
    id: "assistant-2",
    role: "assistant",
    parts: [{ type: "text", text: "Follow-up answer" }],
  },
] as ChatMessage[];

const messagesWithHistoricalToolGroup = [
  messages[0],
  {
    id: "assistant-agent-1",
    role: "assistant",
    metadata: { mode: "agent", generationStartedAt: Date.now() },
    parts: [
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
      { type: "reasoning", text: "Continuing" },
    ],
  },
] as ChatMessage[];

const messagesWithStaggeredHistoricalToolGroups = [
  messages[0],
  {
    ...messagesWithHistoricalToolGroup[1],
    parts: [
      ...messagesWithHistoricalToolGroup[1].parts.slice(0, -1),
      {
        type: "tool-shell",
        toolCallId: "shell-2",
        state: "output-available",
      },
      {
        type: "tool-shell",
        toolCallId: "shell-3",
        state: "output-available",
      },
      { type: "step-start" },
      { type: "reasoning", text: "Continuing" },
    ],
  },
] as ChatMessage[];

function AutoResumeState({
  active = true,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  const { setIsAutoResuming } = useDataStreamDispatch();

  useLayoutEffect(() => {
    setIsAutoResuming(active);
  }, [active, setIsAutoResuming]);

  return children;
}

describe("Messages virtualized row invalidation", () => {
  beforeEach(() => {
    mockLegendListScrollToIndex.mockReset();
    mockLegendListScrollToIndex.mockResolvedValue(undefined);
  });
  it("invalidates the virtualized row when editing starts", () => {
    render(
      <DataStreamProvider>
        <Messages
          chatId="chat-1"
          messages={messages}
          setMessages={jest.fn()}
          onRegenerate={jest.fn()}
          onRetry={jest.fn()}
          onEditMessage={jest.fn()}
          status="ready"
          error={null}
          scrollRef={createRef<HTMLElement>()}
          contentRef={createRef<HTMLElement>()}
          isMobile
        />
      </DataStreamProvider>,
    );

    expect(screen.queryByTestId("message-editor")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));

    expect(screen.getByTestId("message-editor")).toHaveTextContent(
      "Editing user-1",
    );
  });

  it("updates the virtualized dataset identity when the task changes", () => {
    const props = {
      messages,
      setMessages: jest.fn(),
      onRegenerate: jest.fn(),
      onRetry: jest.fn(),
      onEditMessage: jest.fn(),
      status: "ready" as const,
      error: null,
      scrollRef: createRef<HTMLElement>(),
      contentRef: createRef<HTMLElement>(),
      isMobile: true,
    };
    const { rerender } = render(
      <DataStreamProvider>
        <Messages chatId="chat-1" {...props} />
      </DataStreamProvider>,
    );

    expect(screen.getByTestId("messages-container")).toHaveAttribute(
      "data-list-key",
      "chat-1",
    );

    rerender(
      <DataStreamProvider>
        <Messages chatId="chat-2" {...props} />
      </DataStreamProvider>,
    );

    expect(screen.getByTestId("messages-container")).toHaveAttribute(
      "data-list-key",
      "chat-2",
    );
  });

  it("reserves the measured composer overlay height at the end", () => {
    render(
      <DataStreamProvider>
        <Messages
          chatId="chat-1"
          messages={messages}
          setMessages={jest.fn()}
          onRegenerate={jest.fn()}
          onRetry={jest.fn()}
          onEditMessage={jest.fn()}
          status="ready"
          error={null}
          scrollRef={createRef<HTMLElement>()}
          contentRef={createRef<HTMLElement>()}
          isMobile
          contentInsetEndAdjustment={144}
        />
      </DataStreamProvider>,
    );

    expect(screen.getByTestId("messages-container")).toHaveAttribute(
      "data-content-inset-end",
      "144",
    );
  });

  it("invalidates the final assistant row when streaming stops", () => {
    const sharedProps = {
      chatId: "chat-1",
      messages,
      setMessages: jest.fn(),
      onRegenerate: jest.fn(),
      onRetry: jest.fn(),
      onEditMessage: jest.fn(),
      error: null,
      scrollRef: createRef<HTMLElement>(),
      contentRef: createRef<HTMLElement>(),
      isMobile: true,
    };
    const { rerender } = render(
      <DataStreamProvider>
        <Messages {...sharedProps} status="streaming" />
      </DataStreamProvider>,
    );

    expect(screen.getByTestId("message-assistant-1")).toHaveAttribute(
      "data-status",
      "streaming",
    );

    rerender(
      <DataStreamProvider>
        <Messages {...sharedProps} status="ready" />
      </DataStreamProvider>,
    );

    expect(screen.getByTestId("message-assistant-1")).toHaveAttribute(
      "data-status",
      "ready",
    );
  });

  it("keeps the timeline footer height stable when loading starts", () => {
    const sharedProps = {
      chatId: "chat-1",
      messages: messages.slice(0, 1),
      setMessages: jest.fn(),
      onRegenerate: jest.fn(),
      onRetry: jest.fn(),
      onEditMessage: jest.fn(),
      error: null,
      scrollRef: createRef<HTMLElement>(),
      contentRef: createRef<HTMLElement>(),
      isMobile: true,
    };
    const { rerender } = render(
      <DataStreamProvider>
        <Messages {...sharedProps} status="ready" />
      </DataStreamProvider>,
    );

    expect(screen.getByTestId("messages-timeline-footer")).toHaveClass(
      "min-h-20",
    );

    rerender(
      <DataStreamProvider>
        <Messages {...sharedProps} status="submitted" />
      </DataStreamProvider>,
    );

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.getByTestId("messages-timeline-footer")).toHaveClass(
      "min-h-20",
    );
    expect(screen.getByTestId("messages-timeline-footer")).not.toHaveClass(
      "pb-20",
    );
  });

  it("starts tool groups already present on page load collapsed", () => {
    render(
      <DataStreamProvider>
        <Messages
          chatId="chat-with-history"
          messages={messagesWithHistoricalToolGroup}
          setMessages={jest.fn()}
          onRegenerate={jest.fn()}
          onRetry={jest.fn()}
          onEditMessage={jest.fn()}
          status="streaming"
          error={null}
          scrollRef={createRef<HTMLElement>()}
          contentRef={createRef<HTMLElement>()}
          isMobile
        />
      </DataStreamProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: /read a file, ran a command\. show tool details/i,
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a reconnect snapshot collapsed when it arrives after the user row", () => {
    const sharedProps = {
      chatId: "chat-with-reconnect",
      setMessages: jest.fn(),
      onRegenerate: jest.fn(),
      onRetry: jest.fn(),
      onEditMessage: jest.fn(),
      status: "streaming" as const,
      error: null,
      scrollRef: createRef<HTMLElement>(),
      contentRef: createRef<HTMLElement>(),
      isMobile: true,
    };
    const { rerender } = render(
      <DataStreamProvider>
        <Messages messages={[messages[0]]} {...sharedProps} />
      </DataStreamProvider>,
    );

    rerender(
      <DataStreamProvider>
        <Messages messages={messagesWithHistoricalToolGroup} {...sharedProps} />
      </DataStreamProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: /read a file, ran a command\. show tool details/i,
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps replayed tool groups collapsed while an Agent stream reconnects", () => {
    const liveAgentStart = {
      ...messagesWithHistoricalToolGroup[1],
      parts: [{ type: "reasoning", text: "Starting" }],
    } as ChatMessage;
    const sharedProps = {
      chatId: "chat-with-active-reconnect",
      setMessages: jest.fn(),
      onRegenerate: jest.fn(),
      onRetry: jest.fn(),
      onEditMessage: jest.fn(),
      status: "streaming" as const,
      error: null,
      scrollRef: createRef<HTMLElement>(),
      contentRef: createRef<HTMLElement>(),
      isMobile: true,
    };
    const { rerender } = render(
      <DataStreamProvider>
        <AutoResumeState>
          <Messages messages={[messages[0], liveAgentStart]} {...sharedProps} />
        </AutoResumeState>
      </DataStreamProvider>,
    );

    rerender(
      <DataStreamProvider>
        <AutoResumeState active={false}>
          <Messages messages={[messages[0], liveAgentStart]} {...sharedProps} />
        </AutoResumeState>
      </DataStreamProvider>,
    );

    expect(screen.getByTestId("agent-activity-row")).toHaveAttribute(
      "data-suppress-reasoning-auto-open",
      "true",
    );

    rerender(
      <DataStreamProvider>
        <AutoResumeState active={false}>
          <Messages
            messages={messagesWithHistoricalToolGroup}
            {...sharedProps}
          />
        </AutoResumeState>
      </DataStreamProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: /read a file, ran a command\. show tool details/i,
      }),
    ).toHaveAttribute("aria-expanded", "false");

    rerender(
      <DataStreamProvider>
        <AutoResumeState active={false}>
          <Messages
            messages={messagesWithStaggeredHistoricalToolGroups}
            {...sharedProps}
          />
        </AutoResumeState>
      </DataStreamProvider>,
    );

    const replayedGroups = screen.getAllByTestId("agent-tool-group-row");
    expect(replayedGroups).toHaveLength(2);
    for (const group of replayedGroups) {
      expect(group).toHaveAttribute("data-state", "closed");
    }
  });

  it("still animates a new group appended to an observed live agent message", () => {
    const liveAgentStart = {
      ...messagesWithHistoricalToolGroup[1],
      parts: [{ type: "reasoning", text: "Starting" }],
    } as ChatMessage;
    const sharedProps = {
      chatId: "chat-with-live-group",
      setMessages: jest.fn(),
      onRegenerate: jest.fn(),
      onRetry: jest.fn(),
      onEditMessage: jest.fn(),
      status: "streaming" as const,
      error: null,
      scrollRef: createRef<HTMLElement>(),
      contentRef: createRef<HTMLElement>(),
      isMobile: true,
    };
    const { rerender } = render(
      <DataStreamProvider>
        <Messages messages={[messages[0], liveAgentStart]} {...sharedProps} />
      </DataStreamProvider>,
    );

    expect(screen.getByTestId("agent-activity-row")).toHaveAttribute(
      "data-suppress-reasoning-auto-open",
      "false",
    );

    rerender(
      <DataStreamProvider>
        <Messages messages={messagesWithHistoricalToolGroup} {...sharedProps} />
      </DataStreamProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: /read a file, ran a command\. hide tool details/i,
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("jumps to a navigator target without animation", async () => {
    render(
      <DataStreamProvider>
        <Messages
          chatId="chat-1"
          messages={navigatorMessages}
          setMessages={jest.fn()}
          onRegenerate={jest.fn()}
          onRetry={jest.fn()}
          onEditMessage={jest.fn()}
          status="ready"
          error={null}
          scrollRef={createRef<HTMLElement>()}
          contentRef={createRef<HTMLElement>()}
          isMobile={false}
        />
      </DataStreamProvider>,
    );

    const navigator = screen.getByRole("button", {
      name: "Jump to message: User message",
    });
    fireEvent.focus(navigator);
    fireEvent.keyDown(navigator, { key: "Enter" });

    await waitFor(() => {
      expect(mockLegendListScrollToIndex).toHaveBeenCalledTimes(1);
    });
    expect(mockLegendListScrollToIndex).toHaveBeenCalledWith({
      animated: false,
      index: 0,
      viewOffset: 24,
    });
  });
});
