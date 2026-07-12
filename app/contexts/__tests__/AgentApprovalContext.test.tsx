import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";

const mockSendAgentApprovalSessionInput = jest.fn(
  async (args: { onAccessTokenRefreshed?: (token: string) => void }) => {
    args.onAccessTokenRefreshed?.("fresh-approval-token");
  },
);

jest.mock("@/lib/chat/agent-approval-session", () => ({
  sendAgentApprovalSessionInput: (args: unknown) =>
    mockSendAgentApprovalSessionInput(
      args as { onAccessTokenRefreshed?: (token: string) => void },
    ),
}));

import {
  AgentApprovalProvider,
  useAgentApproval,
} from "@/app/contexts/AgentApprovalContext";

const ApprovalHarness = () => {
  const {
    session,
    setAgentApprovalSession,
    sendToolApproval,
    toolApprovalSendStates,
  } = useAgentApproval();

  useEffect(() => {
    setAgentApprovalSession({
      chatId: "chat-1",
      sessionId: "approval-session",
      publicAccessToken: "expired-approval-token",
    });
  }, [setAgentApprovalSession]);

  return (
    <>
      <span data-testid="approval-token">{session?.publicAccessToken}</span>
      <span data-testid="approval-state">
        {toolApprovalSendStates["approval-1"] ?? "idle"}
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
};

const ApprovalHandoffHarness = () => {
  const {
    activeToolApprovalRequest,
    setActiveToolApprovalRequest,
    settleActiveToolApprovalRequest,
  } = useAgentApproval();

  return (
    <>
      <span data-testid="active-approval-id">
        {activeToolApprovalRequest?.approvalId ?? "none"}
      </span>
      <button
        type="button"
        onClick={() =>
          setActiveToolApprovalRequest({
            approvalId: "approval-1",
            toolCallId: "tool-1",
            title: "Approve the first command?",
          })
        }
      >
        Show first
      </button>
      <button
        type="button"
        onClick={() =>
          settleActiveToolApprovalRequest({
            approvalId: "approval-1",
            toolCallId: "tool-1",
          })
        }
      >
        Settle first
      </button>
      <button
        type="button"
        onClick={() =>
          setActiveToolApprovalRequest({
            approvalId: "approval-2",
            toolCallId: "tool-2",
            title: "Approve the second command?",
          })
        }
      >
        Show second
      </button>
    </>
  );
};

describe("AgentApprovalProvider", () => {
  beforeEach(() => {
    mockSendAgentApprovalSessionInput.mockClear();
  });

  it("stores a refreshed approval token and settles the send state", async () => {
    render(
      <AgentApprovalProvider>
        <ApprovalHarness />
      </AgentApprovalProvider>,
    );

    await screen.findByText("expired-approval-token");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(screen.getByTestId("approval-token")).toHaveTextContent(
        "fresh-approval-token",
      );
      expect(screen.getByTestId("approval-state")).toHaveTextContent(
        "approved",
      );
    });
    expect(mockSendAgentApprovalSessionInput).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        sessionId: "approval-session",
        accessToken: "expired-approval-token",
        partId: "agent-tool-approval:approval-1:approve:full_access",
      }),
    );
  });

  it("stays in the sending state while session input is refreshing", async () => {
    let finishSending: (() => void) | undefined;
    mockSendAgentApprovalSessionInput.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSending = resolve;
        }),
    );

    render(
      <AgentApprovalProvider>
        <ApprovalHarness />
      </AgentApprovalProvider>,
    );

    await screen.findByText("expired-approval-token");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByTestId("approval-state")).toHaveTextContent("sending"),
    );

    await act(async () => finishSending?.());

    await waitFor(() =>
      expect(screen.getByTestId("approval-state")).toHaveTextContent(
        "approved",
      ),
    );
  });

  it("keeps the settled prompt mounted until the next approval replaces it", () => {
    jest.useFakeTimers();

    render(
      <AgentApprovalProvider>
        <ApprovalHandoffHarness />
      </AgentApprovalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show first" }));
    fireEvent.click(screen.getByRole("button", { name: "Settle first" }));

    expect(screen.getByTestId("active-approval-id")).toHaveTextContent(
      "approval-1",
    );

    fireEvent.click(screen.getByRole("button", { name: "Show second" }));
    act(() => jest.runOnlyPendingTimers());

    expect(screen.getByTestId("active-approval-id")).toHaveTextContent(
      "approval-2",
    );
    jest.useRealTimers();
  });

  it("clears a settled prompt when no next approval arrives", () => {
    jest.useFakeTimers();

    render(
      <AgentApprovalProvider>
        <ApprovalHandoffHarness />
      </AgentApprovalProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show first" }));
    fireEvent.click(screen.getByRole("button", { name: "Settle first" }));
    act(() => jest.runOnlyPendingTimers());

    expect(screen.getByTestId("active-approval-id")).toHaveTextContent("none");
    jest.useRealTimers();
  });
});
