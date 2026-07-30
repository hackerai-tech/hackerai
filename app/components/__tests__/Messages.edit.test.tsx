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
  }: {
    canEdit: boolean;
    isEditing: boolean;
    message: ChatMessage;
    onStartEdit: (messageId: string) => void;
  }) => (
    <div data-testid={`message-${message.id}`}>
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

describe("Messages editing", () => {
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
});
