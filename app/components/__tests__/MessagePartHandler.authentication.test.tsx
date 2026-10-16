import { render, screen, waitFor } from "@testing-library/react";
import { MessagePartHandler } from "../MessagePartHandler";
import {
  AgentApprovalProvider,
  useAgentApproval,
} from "../../contexts/AgentApprovalContext";
import type { UIMessage } from "ai";

jest.mock("../../hooks/useToolSidebar", () => ({
  useToolSidebar: () => ({
    handleOpenInSidebar: jest.fn(),
    handleKeyDown: jest.fn(),
    isSidebarActive: false,
  }),
}));

function ApprovalPrompt() {
  const { activeToolApprovalRequest } = useAgentApproval();
  return (
    <div data-testid="approval">
      {JSON.stringify(activeToolApprovalRequest)}
    </div>
  );
}

test("authentication checks surface a pending approval with endpoint and both private file references", async () => {
  const part = {
    type: "tool-verify_authentication",
    toolCallId: "auth-call",
    state: "approval-requested",
    input: {
      url: "https://app.example/me",
      credential_file: "/private/cookies",
      credential_format: "netscape",
      expectation_file: "/private/alice.json",
    },
    approval: { id: "auth-approval" },
  };
  render(
    <AgentApprovalProvider>
      <MessagePartHandler
        message={
          { id: "m1", role: "assistant", parts: [part] } as unknown as UIMessage
        }
        part={part}
        partIndex={0}
        status="streaming"
      />
      <ApprovalPrompt />
    </AgentApprovalProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("approval")).toHaveTextContent(
      '"approvalId":"auth-approval"',
    ),
  );
  expect(screen.getByTestId("approval")).toHaveTextContent(
    "https://app.example/me",
  );
  expect(screen.getByTestId("approval")).toHaveTextContent("/private/cookies");
  expect(screen.getByTestId("approval")).toHaveTextContent(
    "/private/alice.json",
  );
  expect(screen.getByTestId("approval")).toHaveTextContent(
    '"operation":"terminal_execute"',
  );
});
