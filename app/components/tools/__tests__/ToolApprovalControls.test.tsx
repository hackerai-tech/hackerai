import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";

let resolveApprovalInput: (() => void) | undefined;
const mockSendAgentApprovalSessionInput = jest.fn(
  () =>
    new Promise<void>((resolve) => {
      resolveApprovalInput = resolve;
    }),
);
const approvalPrefixRule = ["ping", "-c", "4"];

jest.mock("@/lib/chat/agent-approval-session", () => ({
  sendAgentApprovalSessionInput: () => mockSendAgentApprovalSessionInput(),
}));

import {
  AgentApprovalProvider,
  useAgentApproval,
} from "@/app/contexts/AgentApprovalContext";
import {
  getToolApprovalDisplayState,
  ToolApprovalControls,
} from "../ToolApprovalControls";

function ApprovalStatusHarness() {
  const {
    activeToolApprovalRequest,
    setAgentApprovalSession,
    sendToolApproval,
  } = useAgentApproval();

  useEffect(() => {
    setAgentApprovalSession({
      chatId: "chat-1",
      sessionId: "session-1",
      publicAccessToken: "token-1",
    });
  }, [setAgentApprovalSession]);

  return (
    <>
      <ToolApprovalControls
        approvalId="approval-1"
        toolCallId="tool-1"
        title="Allow HackerAI to run this terminal command?"
        target="ping -c 4 hackerone.com"
        justification="Check whether the target host is reachable."
        prefixRule={approvalPrefixRule}
        kind="terminal"
        operation="terminal_execute"
      >
        {(sendState) => (
          <span data-testid="approval-row-state">{sendState}</span>
        )}
      </ToolApprovalControls>
      <span data-testid="active-approval-request">
        {JSON.stringify(activeToolApprovalRequest)}
      </span>
      <button
        type="button"
        onClick={() =>
          void sendToolApproval({
            approvalId: "approval-1",
            toolCallId: "tool-1",
            decision: "approve",
          })
        }
      >
        Approve
      </button>
    </>
  );
}

describe("ToolApprovalControls", () => {
  beforeEach(() => {
    resolveApprovalInput = undefined;
    mockSendAgentApprovalSessionInput.mockClear();
  });

  it("shows approval sending until the server accepts the input", async () => {
    render(
      <AgentApprovalProvider>
        <ApprovalStatusHarness />
      </AgentApprovalProvider>,
    );

    expect(screen.getByTestId("approval-row-state")).toHaveTextContent("idle");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByTestId("approval-row-state")).toHaveTextContent(
        "sending",
      ),
    );

    await act(async () => {
      resolveApprovalInput?.();
    });

    await waitFor(() =>
      expect(screen.getByTestId("approval-row-state")).toHaveTextContent(
        "approved",
      ),
    );
    expect(screen.getByTestId("active-approval-request")).toHaveTextContent(
      '"approvalId":"approval-1"',
    );
  });

  it("forwards live approval metadata to the ChatInput prompt", async () => {
    render(
      <AgentApprovalProvider>
        <ApprovalStatusHarness />
      </AgentApprovalProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("active-approval-request")).toHaveTextContent(
        JSON.stringify({
          approvalId: "approval-1",
          toolCallId: "tool-1",
          title: "Allow HackerAI to run this terminal command?",
          target: "ping -c 4 hackerone.com",
          justification: "Check whether the target host is reachable.",
          prefixRule: ["ping", "-c", "4"],
          kind: "terminal",
          operation: "terminal_execute",
        }),
      ),
    );
  });

  it("maps approval send states to immediate tool-row labels", () => {
    expect(
      getToolApprovalDisplayState({
        sendState: "idle",
        approvedAction: "Executing",
        deniedAction: "Command denied",
      }),
    ).toEqual({ action: "Awaiting approval", isShimmer: false });
    expect(
      getToolApprovalDisplayState({
        sendState: "sending",
        approvedAction: "Executing",
        deniedAction: "Command denied",
      }),
    ).toEqual({ action: "Approving", isShimmer: true });
    expect(
      getToolApprovalDisplayState({
        sendState: "approved",
        approvedAction: "Executing",
        deniedAction: "Command denied",
      }),
    ).toEqual({ action: "Executing", isShimmer: true });
    expect(
      getToolApprovalDisplayState({
        sendState: "denied",
        approvedAction: "Executing",
        deniedAction: "Command denied",
      }),
    ).toEqual({ action: "Command denied", isShimmer: false });
  });
});
