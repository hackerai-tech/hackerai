import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockSendToolApproval = jest.fn(() => Promise.resolve());

jest.mock("@/app/contexts/AgentApprovalContext", () => ({
  useAgentApproval: () => ({
    session: {
      chatId: "approval-chat",
      sessionId: "agent-approval-session",
      publicAccessToken: "public-token",
    },
    sendToolApproval: mockSendToolApproval,
    toolApprovalSendStates: {},
  }),
}));

const { AgentApprovalPrompt } = jest.requireActual<
  typeof import("../AgentApprovalPrompt")
>("../AgentApprovalPrompt");

const request = {
  approvalId: "approval-1",
  toolCallId: "tool-1",
  title: "Allow HackerAI to run this terminal command?",
  target: "ping -c 4 hackerone.com",
  justification: "Check whether the target host is reachable.",
  prefixRule: ["ping", "-c", "4"],
  detail: "Approve to continue, or deny to stop this command.",
  kind: "terminal" as const,
  operation: "terminal_execute" as const,
};

describe("AgentApprovalPrompt", () => {
  beforeEach(() => {
    mockSendToolApproval.mockClear();
  });

  it("renders a compact approval card instead of selectable option rows", () => {
    render(<AgentApprovalPrompt request={request} />);

    expect(screen.getByText("Terminal command")).toBeInTheDocument();
    expect(screen.getByText(request.title)).toBeInTheDocument();
    expect(screen.getByText(request.justification)).toBeInTheDocument();
    expect(screen.getByText(request.target)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Allow once" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More approval options" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("approves once when Enter is pressed", async () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
      }),
    );
  });

  it("approves once from the primary action", async () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
      }),
    );
  });

  it("approves the validated command prefix for this conversation", async () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.keyDown(
      screen.getByRole("button", { name: "More approval options" }),
      { key: "ArrowDown", code: "ArrowDown" },
    );
    expect(
      screen.queryByText("Commands starting with ping -c 4"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Allow this conversation: Commands starting with ping -c 4",
      }),
    );

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
        grant: "target_prefix",
        targetKind: "terminal_command",
        targetPrefix: '["ping","-c","4"]',
      }),
    );
  });

  it("does not offer conversation reuse for an unsafe command", () => {
    render(
      <AgentApprovalPrompt
        request={{
          ...request,
          target: "npm test && npm publish",
          prefixRule: ["npm", "test"],
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "More approval options" }),
    ).not.toBeInTheDocument();
  });

  it("denies from the secondary action", async () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "deny",
      }),
    );
  });

  it("does not capture Enter from another editable field", () => {
    render(
      <>
        <input aria-label="Outside input" />
        <AgentApprovalPrompt request={request} />
      </>,
    );

    fireEvent.keyDown(screen.getByLabelText("Outside input"), {
      key: "Enter",
      code: "Enter",
    });

    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });

  it("does not submit modified Enter shortcuts", () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.keyDown(document.body, {
      key: "Enter",
      code: "Enter",
      shiftKey: true,
    });

    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });
});
