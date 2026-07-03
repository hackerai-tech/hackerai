import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { UIMessage } from "@ai-sdk/react";
import { ReasoningHandler } from "../ReasoningHandler";

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
});
