import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { DataStreamProvider } from "../DataStreamProvider";
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
  AgentActivityRow: () => null,
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
