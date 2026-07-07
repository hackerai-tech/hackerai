import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
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
  title: "The agent wants full access to run this terminal command.",
  target: "ping -c 4 hackerone.com",
  detail: "Approve to continue, or deny to stop this command.",
};

describe("AgentApprovalPrompt", () => {
  beforeEach(() => {
    mockSendToolApproval.mockClear();
  });

  it("submits the selected approval option when Enter is pressed", async () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.keyDown(screen.getByTestId("agent-approval-prompt"), {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
      }),
    );
  });

  it("submits the focused approval option when Enter is pressed", async () => {
    render(<AgentApprovalPrompt request={request} />);

    const denyOption = screen.getByText("Deny").closest("button");
    expect(denyOption).toBeInTheDocument();

    fireEvent.keyDown(denyOption!, {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "deny",
      }),
    );
  });

  it("treats Skip as a denied approval response", async () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "deny",
      }),
    );
  });

  it("navigates approval options with ArrowUp and ArrowDown", async () => {
    render(<AgentApprovalPrompt request={request} />);

    const prompt = screen.getByTestId("agent-approval-prompt");
    const approveOption = screen.getByRole("radio", {
      name: /Approve full access/,
    });
    const denyOption = screen.getByRole("radio", { name: /Deny/ });

    expect(approveOption).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByTestId("agent-approval-option-approve-arrows"),
    ).toBeInTheDocument();

    fireEvent.keyDown(prompt, { key: "ArrowDown", code: "ArrowDown" });

    expect(denyOption).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByTestId("agent-approval-option-deny-arrows"),
    ).toBeInTheDocument();

    fireEvent.keyDown(denyOption, { key: "ArrowUp", code: "ArrowUp" });

    expect(approveOption).toHaveAttribute("aria-checked", "true");
  });

  it("navigates approval options from page-level arrow keys", async () => {
    render(<AgentApprovalPrompt request={request} />);

    const approveOption = screen.getByRole("radio", {
      name: /Approve full access/,
    });
    const denyOption = screen.getByRole("radio", { name: /Deny/ });

    fireEvent.keyDown(document.body, { key: "ArrowDown", code: "ArrowDown" });

    expect(denyOption).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(document.body, { key: "ArrowUp", code: "ArrowUp" });

    expect(approveOption).toHaveAttribute("aria-checked", "true");
  });

  it("submits the selected approval option from page-level Enter", async () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.keyDown(document.body, {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
      }),
    );
  });

  it("submits the page-selected approval option from page-level Enter", async () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.keyDown(document.body, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "deny",
      }),
    );
  });

  it("does not capture approval keys from editable fields", () => {
    render(
      <>
        <input aria-label="Outside input" />
        <AgentApprovalPrompt request={request} />
      </>,
    );

    const outsideInput = screen.getByLabelText("Outside input");
    const approveOption = screen.getByRole("radio", {
      name: /Approve full access/,
    });
    const denyOption = screen.getByRole("radio", { name: /Deny/ });

    fireEvent.keyDown(outsideInput, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(outsideInput, { key: "Enter", code: "Enter" });

    expect(approveOption).toHaveAttribute("aria-checked", "true");
    expect(denyOption).toHaveAttribute("aria-checked", "false");
    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });

  it("submits the arrow-selected approval option when Enter is pressed", async () => {
    render(<AgentApprovalPrompt request={request} />);

    const prompt = screen.getByTestId("agent-approval-prompt");
    fireEvent.keyDown(prompt, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "deny",
      }),
    );
  });
});
