import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { UIMessage } from "@ai-sdk/react";
import { MessagePartHandler } from "../MessagePartHandler";
import {
  AgentApprovalProvider,
  useAgentApproval,
} from "@/app/contexts/AgentApprovalContext";

jest.mock("@/app/hooks/useToolSidebar", () => ({
  useToolSidebar: () => ({
    handleOpenInSidebar: jest.fn(),
    handleKeyDown: jest.fn(),
  }),
}));

function ActiveRequest() {
  const { activeToolApprovalRequest } = useAgentApproval();
  return (
    <output data-testid="active-request">
      {activeToolApprovalRequest?.approvalId ?? "none"}
    </output>
  );
}

describe("tool approval message ownership", () => {
  it.each(["tool-run_terminal_cmd", "tool-file"])(
    "only registers %s approvals for the latest active message",
    (type) => {
      const part = {
        type,
        toolCallId: "tool-1",
        state: "approval-requested",
        approval: { id: "approval-1" },
        input:
          type === "tool-file"
            ? { action: "write", path: "/tmp/qa.txt", text: "test" }
            : { command: "printf test" },
      };
      const message = {
        id: "assistant-1",
        role: "assistant",
        parts: [part],
      } as UIMessage;
      const view = (
        status: "streaming" | "ready" | "error",
        latest: boolean,
        loadHistory = false,
      ) => (
        <AgentApprovalProvider>
          <MessagePartHandler
            message={message}
            part={part}
            partIndex={0}
            status={status}
            isLastMessage={latest}
          />
          {loadHistory && (
            <MessagePartHandler
              message={message}
              part={{
                ...part,
                toolCallId: "tool-1",
                approval: { id: "old-approval" },
              }}
              partIndex={0}
              status={status}
              isLastMessage={false}
            />
          )}
          <ActiveRequest />
        </AgentApprovalProvider>
      );
      const { rerender } = render(view("streaming", true));
      expect(screen.getByTestId("active-request")).toHaveTextContent(
        "approval-1",
      );
      rerender(view("ready", true));
      expect(screen.getByTestId("active-request")).toHaveTextContent("none");
      rerender(view("streaming", false));
      expect(screen.getByTestId("active-request")).toHaveTextContent("none");
      rerender(view("streaming", true, true));
      expect(screen.getByTestId("active-request")).toHaveTextContent(
        "approval-1",
      );
      rerender(view("error", true, true));
      expect(screen.getByTestId("active-request")).toHaveTextContent(
        "approval-1",
      );
    },
  );
});
