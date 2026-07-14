import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "@ai-sdk/react";
import { ReasoningHandler } from "../ReasoningHandler";

const StreamingReasoningParts = ({ message }: { message: UIMessage }) => (
  <>
    {message.parts.map((part, partIndex) =>
      part.type === "reasoning" ? (
        <ReasoningHandler
          key={partIndex}
          message={message}
          partIndex={partIndex}
          status="streaming"
          isLastMessage
          keepLatestOpenDuringStreaming
        />
      ) : null,
    )}
  </>
);

describe("ReasoningHandler", () => {
  it("renders OpenRouter reasoning parts with reasoning_details metadata", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          state: "done",
          text: "Visible reasoning text",
          providerMetadata: {
            openrouter: {
              reasoning_details: [
                { type: "reasoning.text", text: "Visible reasoning text" },
              ],
            },
          },
        },
      ],
    } as unknown as UIMessage;

    render(
      <ReasoningHandler
        message={message}
        partIndex={0}
        status="streaming"
        isLastMessage
      />,
    );

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    expect(screen.getByText("Visible reasoning text")).toBeInTheDocument();
  });

  it("keeps the latest reasoning open while its tool is running", async () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", state: "done", text: "Planning the tool" },
        {
          type: "tool-run_terminal_cmd",
          state: "input-available",
          toolCallId: "tool-1",
          input: { command: "printf test" },
        },
      ],
    } as unknown as UIMessage;

    render(
      <ReasoningHandler
        message={message}
        partIndex={1}
        status="streaming"
        isLastMessage
        keepLatestOpenDuringStreaming
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Planning the tool")).toBeVisible();
    });
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("preserves last-part auto-collapse outside the Agent work panel", async () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "reasoning", state: "done", text: "Finished reasoning" },
        { type: "text", state: "streaming", text: "Answering" },
      ],
    } as unknown as UIMessage;

    render(
      <ReasoningHandler
        message={message}
        partIndex={0}
        status="streaming"
        isLastMessage
      />,
    );

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Finished reasoning")).not.toBeInTheDocument();
    });
  });

  it("collapses the previous reasoning only when a newer block appears", async () => {
    const initialMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", state: "done", text: "Planning the tool" },
        {
          type: "tool-run_terminal_cmd",
          state: "output-available",
          toolCallId: "tool-1",
          input: { command: "printf test" },
          output: "test",
        },
      ],
    } as unknown as UIMessage;

    const { rerender } = render(
      <StreamingReasoningParts message={initialMessage} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Planning the tool")).toBeVisible();
    });

    const emptyNextReasoning = {
      ...initialMessage,
      parts: [
        ...initialMessage.parts,
        { type: "step-start" },
        { type: "reasoning", state: "streaming", text: "" },
      ],
    } as unknown as UIMessage;
    rerender(<StreamingReasoningParts message={emptyNextReasoning} />);

    expect(screen.getByText("Planning the tool")).toBeVisible();

    const visibleNextReasoning = {
      ...emptyNextReasoning,
      parts: emptyNextReasoning.parts.map((part, index) =>
        index === 4 ? { ...part, text: "Reviewing output" } : part,
      ),
    } as unknown as UIMessage;
    rerender(<StreamingReasoningParts message={visibleNextReasoning} />);

    await waitFor(() => {
      expect(screen.queryByText("Planning the tool")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Reviewing output")).toBeVisible();
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("leaves the latest reasoning open for the parent completion collapse", async () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", state: "done", text: "Reviewing output" },
        { type: "text", state: "done", text: "Done" },
      ],
    } as unknown as UIMessage;

    const { rerender } = render(
      <ReasoningHandler
        message={message}
        partIndex={1}
        status="streaming"
        isLastMessage
        keepLatestOpenDuringStreaming
        deferCollapseUntilParent
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Reviewing output")).toBeVisible();
    });

    rerender(
      <ReasoningHandler
        message={message}
        partIndex={1}
        status="ready"
        isLastMessage
        keepLatestOpenDuringStreaming
        deferCollapseUntilParent
      />,
    );

    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Reviewing output")).toBeVisible();
  });
});
