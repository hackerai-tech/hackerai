import { render, screen } from "@testing-library/react";
import { AgentActivityRow } from "../AgentActivityRow";
import type { ChatMessage } from "@/types";

jest.mock("../MessagePartHandler", () => ({
  MessagePartHandler: () => <div>Activity content</div>,
}));

describe("AgentActivityRow", () => {
  it("uses its measured content height inside the virtualized timeline", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "Reasoning" }],
    } as unknown as ChatMessage;

    render(
      <AgentActivityRow
        deferReasoningCollapseUntilParent={false}
        isLastMessage
        keepLatestReasoningOpenDuringStreaming={false}
        suppressReasoningAutoOpen
        message={message}
        part={message.parts[0]}
        partIndex={0}
        status="streaming"
        terminalChunksByToolCallId={new Map()}
      />,
    );

    expect(screen.getByTestId("agent-activity-row")).not.toHaveClass(
      "message-row",
    );
  });
});
