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
  const { setAgentApprovalSession, sendToolApproval } = useAgentApproval();

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
        title="Approve command"
      >
        {(sendState) => (
          <span data-testid="approval-row-state">{sendState}</span>
        )}
      </ToolApprovalControls>
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

  it("updates the tool row before the streamed tool part settles", async () => {
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
