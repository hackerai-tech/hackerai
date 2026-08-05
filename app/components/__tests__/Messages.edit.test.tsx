import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { DataStreamProvider } from "../DataStreamProvider";
import { Messages } from "../Messages";
import type { ChatMessage } from "@/types";

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

describe("Messages virtualized row invalidation", () => {
  it("invalidates the virtualized row when editing starts", () => {
    render(
      <DataStreamProvider>
        <Messages
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

  it("invalidates the final assistant row when streaming stops", () => {
    const sharedProps = {
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
});
