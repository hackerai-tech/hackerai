import { describe, expect, it } from "@jest/globals";
import React from "react";
import { render, screen } from "@testing-library/react";
import {
  areMessagePartHandlerPropsEqual,
  MessagePartHandler,
} from "../MessagePartHandler";

jest.mock("../MemoizedMarkdown", () => ({
  MemoizedMarkdown: ({
    content,
    isAnimating,
  }: {
    content: string;
    isAnimating: boolean;
  }) =>
    React.createElement(
      "div",
      { "data-animating": String(isAnimating), "data-testid": "markdown" },
      content,
    ),
}));

const basePart = {
  type: "tool-create_agent",
  toolCallId: "tool-create-1",
  state: "output-available",
  output: { success: true, agent_id: "sa_1" },
};

const props = (parts: unknown[]) =>
  ({
    message: { id: "parent-1", role: "assistant", parts },
    part: basePart,
    partIndex: 0,
    status: "ready",
  }) as any;

describe("MessagePartHandler subagent memoization", () => {
  it("re-renders when lifecycle data arrives for an unchanged tool part", () => {
    const previous = props([basePart]);
    const next = props([
      basePart,
      {
        type: "data-subagent-lifecycle",
        data: {
          subagent_id: "sa_1",
          parent_message_id: "parent-1",
          parent_tool_call_id: "tool-create-1",
          agent_name: "XSS validator",
          event: "started",
          status: "running",
        },
      },
    ]);

    expect(areMessagePartHandlerPropsEqual(previous, next)).toBe(false);
    expect(areMessagePartHandlerPropsEqual(next, next)).toBe(true);
  });

  it("marks only the latest actively streaming assistant markdown as animating", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "streaming code" }],
    } as any;

    const { rerender } = render(
      React.createElement(MessagePartHandler, {
        message,
        part: message.parts[0],
        partIndex: 0,
        status: "streaming",
        isLastMessage: true,
      }),
    );

    expect(screen.getByTestId("markdown")).toHaveAttribute(
      "data-animating",
      "true",
    );

    rerender(
      React.createElement(MessagePartHandler, {
        message,
        part: message.parts[0],
        partIndex: 0,
        status: "streaming",
        isLastMessage: false,
      }),
    );

    expect(screen.getByTestId("markdown")).toHaveAttribute(
      "data-animating",
      "false",
    );
  });
});
