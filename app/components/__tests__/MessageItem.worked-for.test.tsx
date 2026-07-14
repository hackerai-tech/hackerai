import { fireEvent, render, screen } from "@testing-library/react";
import { MessageItem } from "../MessageItem";
import type { ChatMessage, ChatMode, ChatStatus } from "@/types";

jest.mock("../MessagePartHandler", () => ({
  MessagePartHandler: ({
    part,
    keepLatestReasoningOpenDuringStreaming,
    deferReasoningCollapseUntilParent,
  }: {
    part: any;
    keepLatestReasoningOpenDuringStreaming?: boolean;
    deferReasoningCollapseUntilParent?: boolean;
  }) => (
    <div
      data-testid={`part-${part.type}`}
      data-keep-latest-reasoning-open={String(
        !!keepLatestReasoningOpenDuringStreaming,
      )}
      data-defer-reasoning-collapse={String(
        !!deferReasoningCollapseUntilParent,
      )}
    >
      {part.text ?? part.input ?? part.type}
    </div>
  ),
}));

jest.mock("../MessageActions", () => ({
  MessageActions: () => <div data-testid="message-actions" />,
}));

jest.mock("../FilePartRenderer", () => ({
  FilePartRenderer: () => <div data-testid="file-part" />,
}));

jest.mock("../MessageEditor", () => ({
  MessageEditor: () => <div data-testid="message-editor" />,
}));

jest.mock("../FeedbackInput", () => ({
  FeedbackInput: () => <div data-testid="feedback-input" />,
}));

jest.mock("../BranchIndicator", () => ({
  BranchIndicator: () => <div data-testid="branch-indicator" />,
}));

jest.mock("../FinishReasonNotice", () => ({
  FinishReasonNotice: () => null,
}));

const assistantMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [
    {
      type: "tool-shell",
      input: "ran command",
      state: "output-available",
    },
    {
      type: "text",
      text: "final answer",
    },
  ],
  metadata: {
    mode: "agent",
    generationTimeMs: 1_500,
  },
} as unknown as ChatMessage;

const createUserMessage = (text: string) =>
  ({
    id: "user-1",
    role: "user",
    parts: [
      {
        type: "text",
        text,
      },
    ],
  }) as unknown as ChatMessage;

const renderMessageItem = ({
  mode,
  message = assistantMessage,
  status = "ready",
}: {
  mode: ChatMode;
  message?: ChatMessage;
  status?: ChatStatus;
}) =>
  render(
    <MessageItem
      message={message}
      index={0}
      messagesLength={1}
      lastAssistantMessageIndex={0}
      status={status}
      isHovered={false}
      isEditing={false}
      feedbackInputMessageId={null}
      mode={mode}
      branchBoundaryIndex={undefined}
      onMouseEnter={jest.fn()}
      onMouseLeave={jest.fn()}
      onStartEdit={jest.fn()}
      onSaveEdit={jest.fn()}
      onCancelEdit={jest.fn()}
      onRegenerate={jest.fn()}
      onFeedback={jest.fn()}
      onFeedbackSubmit={jest.fn()}
      onFeedbackCancel={jest.fn()}
      onShowAllFiles={jest.fn()}
      getCachedUrl={jest.fn()}
    />,
  );

describe("MessageItem WorkedFor rendering", () => {
  it("renders work inline for messages generated in ask mode", () => {
    renderMessageItem({
      mode: "agent",
      message: {
        ...assistantMessage,
        metadata: {
          mode: "ask",
          generationTimeMs: 1_500,
        },
      } as ChatMessage,
    });

    expect(screen.queryByText(/worked for/i)).not.toBeInTheDocument();
    expect(screen.getByText("ran command")).toBeInTheDocument();
    expect(screen.getByText("final answer")).toBeInTheDocument();
  });

  it("shows Worked for for messages generated in agent mode", () => {
    renderMessageItem({ mode: "ask" });

    expect(
      screen.getByRole("button", { name: /worked for 2s/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("ran command")).not.toBeInTheDocument();
    expect(screen.getByText("final answer")).toBeInTheDocument();
  });

  it("defers the latest reasoning collapse to the active Agent work panel", () => {
    renderMessageItem({
      mode: "agent",
      status: "streaming",
      message: {
        ...assistantMessage,
        parts: [
          { type: "step-start" },
          { type: "reasoning", state: "done", text: "Planning the tool" },
          {
            type: "tool-shell",
            state: "output-available",
            input: "ran command",
          },
          { type: "text", state: "done", text: "final answer" },
        ],
        metadata: {
          mode: "agent",
          generationStartedAt: Date.now(),
        },
      } as unknown as ChatMessage,
    });

    expect(screen.getByTestId("part-reasoning")).toHaveAttribute(
      "data-defer-reasoning-collapse",
      "true",
    );
    expect(screen.getByTestId("part-reasoning")).toHaveAttribute(
      "data-keep-latest-reasoning-open",
      "true",
    );
  });

  it("renders stopped agent work inline when there is no final text", () => {
    renderMessageItem({
      mode: "agent",
      message: {
        ...assistantMessage,
        parts: [
          {
            type: "tool-shell",
            input: "ran command",
            state: "output-available",
          },
        ],
        metadata: {
          mode: "agent",
          generationStartedAt: 1_000,
          generationTimeMs: 2_500,
        },
      } as unknown as ChatMessage,
      status: "ready",
    });

    expect(screen.queryByRole("button", { name: /worked for/i })).toBeNull();
    expect(screen.getByText("ran command")).toBeInTheDocument();
  });

  it("keeps regenerated final text visible when stream metadata trails it", () => {
    renderMessageItem({
      mode: "agent",
      message: {
        ...assistantMessage,
        parts: [
          {
            type: "tool-shell",
            input: "ran command",
            state: "output-available",
          },
          {
            type: "text",
            text: "regenerated final answer",
          },
          {
            type: "data-context-usage",
            data: {},
          },
        ],
        metadata: {
          mode: "agent",
          generationTimeMs: 1_500,
        },
      } as unknown as ChatMessage,
      status: "ready",
    });

    expect(
      screen.getByRole("button", { name: /worked for 2s/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("ran command")).not.toBeInTheDocument();
    expect(screen.getByText("regenerated final answer")).toBeInTheDocument();
  });

  it("does not show an expand icon when there are no expandable work parts", () => {
    renderMessageItem({
      mode: "agent",
      message: {
        ...assistantMessage,
        parts: [
          {
            type: "step-start",
          },
          {
            type: "text",
            text: "final answer",
          },
        ],
        metadata: {
          mode: "agent",
          generationTimeMs: 2_500,
        },
      } as unknown as ChatMessage,
    });

    const trigger = screen.getByRole("button", { name: /worked for 3s/i });

    expect(trigger).toBeDisabled();
    expect(trigger.querySelector("svg")).not.toBeInTheDocument();
    expect(screen.getByText("final answer")).toBeInTheDocument();

    fireEvent.click(trigger);

    expect(screen.queryByTestId("part-step-start")).not.toBeInTheDocument();
  });

  it("does not show an expand icon for reasoning-only work", () => {
    renderMessageItem({
      mode: "agent",
      message: {
        ...assistantMessage,
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "thinking",
          },
          {
            type: "text",
            text: "final answer",
          },
        ],
        metadata: {
          mode: "agent",
          generationTimeMs: 2_500,
        },
      } as unknown as ChatMessage,
    });

    const trigger = screen.getByRole("button", { name: /worked for 3s/i });

    expect(trigger).toBeDisabled();
    expect(trigger.querySelector("svg")).not.toBeInTheDocument();
    expect(screen.getByText("final answer")).toBeInTheDocument();
  });

  it("keeps saved message mode stable when the current picker mode changes", () => {
    const { rerender } = renderMessageItem({ mode: "ask" });

    expect(
      screen.getByRole("button", { name: /worked for 2s/i }),
    ).toBeInTheDocument();

    rerender(
      <MessageItem
        message={assistantMessage}
        index={0}
        messagesLength={1}
        lastAssistantMessageIndex={0}
        status="ready"
        isHovered={false}
        isEditing={false}
        feedbackInputMessageId={null}
        mode="agent"
        branchBoundaryIndex={undefined}
        onMouseEnter={jest.fn()}
        onMouseLeave={jest.fn()}
        onStartEdit={jest.fn()}
        onSaveEdit={jest.fn()}
        onCancelEdit={jest.fn()}
        onRegenerate={jest.fn()}
        onFeedback={jest.fn()}
        onFeedbackSubmit={jest.fn()}
        onFeedbackCancel={jest.fn()}
        onShowAllFiles={jest.fn()}
        getCachedUrl={jest.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /worked for 2s/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("ran command")).not.toBeInTheDocument();
    expect(screen.getByText("final answer")).toBeInTheDocument();
  });

  it("renders legacy messages without saved mode inline", () => {
    renderMessageItem({
      mode: "agent",
      message: {
        ...assistantMessage,
        metadata: {
          generationTimeMs: 1_500,
        },
      } as ChatMessage,
    });

    expect(screen.queryByText(/worked for/i)).not.toBeInTheDocument();
    expect(screen.getByText("ran command")).toBeInTheDocument();
  });
});

describe("MessageItem user message collapse", () => {
  it("collapses long user messages behind a full-message button", () => {
    const longMessage = Array.from({ length: 24 }, (_, index) =>
      index === 19
        ? `line 20 ${"x".repeat(1_300)} exact-line-20-tail`
        : `line ${index + 1}`,
    ).join("\n");

    renderMessageItem({
      mode: "ask",
      message: createUserMessage(longMessage),
    });

    expect(
      screen.getByRole("button", { name: /show fulll message/i }),
    ).toBeInTheDocument();
    const ellipsis = screen.getByText("...");
    expect(ellipsis).toBeInTheDocument();
    expect(ellipsis.tagName).toBe("DIV");
    expect(ellipsis).toHaveTextContent(/^\.{3}$/);
    expect(screen.getByText(/line 20/)).toBeInTheDocument();
    expect(screen.getByText(/exact-line-20-tail/)).toBeInTheDocument();
    expect(screen.queryByText(/line 24/)).not.toBeInTheDocument();
  });

  it("collapses very long single-line user messages by character count", () => {
    const longMessage = `start-${"x".repeat(1_194)}hidden-tail`;

    renderMessageItem({
      mode: "ask",
      message: createUserMessage(longMessage),
    });

    expect(
      screen.getByRole("button", { name: /show fulll message/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/hidden-tail/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /show fulll message/i }),
    );

    expect(screen.getByText(/hidden-tail/)).toBeInTheDocument();
  });

  it("shows the full user message and allows collapsing it again", () => {
    const longMessage = Array.from(
      { length: 24 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");

    renderMessageItem({
      mode: "ask",
      message: createUserMessage(longMessage),
    });

    fireEvent.click(
      screen.getByRole("button", { name: /show fulll message/i }),
    );

    expect(
      screen.queryByRole("button", { name: /show fulll message/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/line 24/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /show less/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show less/i }));

    expect(screen.queryByText(/line 24/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /show fulll message/i }),
    ).toBeInTheDocument();
  });

  it("leaves short user messages expanded", () => {
    renderMessageItem({
      mode: "ask",
      message: createUserMessage("short message"),
    });

    expect(screen.getByText("short message")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show fulll message/i }),
    ).not.toBeInTheDocument();
  });
});
