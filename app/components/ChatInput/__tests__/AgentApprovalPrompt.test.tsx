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
  title: "The agent wants to run this terminal command.",
  target: "ping -c 4 hackerone.com",
  detail: "Approve to continue, or deny to stop this command.",
  kind: "terminal" as const,
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

  it("renders three Codex-style options without option descriptions", () => {
    render(<AgentApprovalPrompt request={request} />);

    expect(screen.getByRole("radio", { name: "Yes" })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", {
        name: /Yes, and don't ask again for commands that start with ping/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("No, and tell Codex what to do differently"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Allow this command or file change to run."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Stop this action and let the agent recover."),
    ).not.toBeInTheDocument();
  });

  it("submits the focused approval option when Enter is pressed", async () => {
    render(<AgentApprovalPrompt request={request} />);

    const prefixOption = screen.getByRole("radio", {
      name: /don't ask again/,
    });

    fireEvent.keyDown(prefixOption, {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
        grant: "target_prefix",
        targetKind: "terminal_command",
        targetPrefix: "ping",
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
    const approveOption = screen.getByRole("radio", { name: "Yes" });
    const prefixOption = screen.getByRole("radio", {
      name: /don't ask again/,
    });
    const feedbackOption = screen.getByRole("radio", {
      name: /tell Codex what to do differently/,
    });

    expect(approveOption).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByTestId("agent-approval-option-approve-arrows"),
    ).toBeInTheDocument();

    fireEvent.keyDown(prompt, { key: "ArrowDown", code: "ArrowDown" });

    expect(prefixOption).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByTestId("agent-approval-option-target_prefix-arrows"),
    ).toBeInTheDocument();

    fireEvent.keyDown(prompt, { key: "ArrowDown", code: "ArrowDown" });

    expect(feedbackOption).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByTestId("agent-approval-option-deny_feedback-arrows"),
    ).toBeInTheDocument();

    fireEvent.keyDown(feedbackOption, { key: "ArrowUp", code: "ArrowUp" });

    expect(prefixOption).toHaveAttribute("aria-checked", "true");
  });

  it("navigates approval options from page-level arrow keys", async () => {
    render(<AgentApprovalPrompt request={request} />);

    const approveOption = screen.getByRole("radio", { name: "Yes" });
    const prefixOption = screen.getByRole("radio", {
      name: /don't ask again/,
    });

    fireEvent.keyDown(document.body, { key: "ArrowDown", code: "ArrowDown" });

    expect(prefixOption).toHaveAttribute("aria-checked", "true");

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

  it("submits the page-selected prefix approval option from page-level Enter", async () => {
    render(<AgentApprovalPrompt request={request} />);

    fireEvent.keyDown(document.body, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
        grant: "target_prefix",
        targetKind: "terminal_command",
        targetPrefix: "ping",
      }),
    );
  });

  it("submits typed feedback with a denied approval response", async () => {
    render(<AgentApprovalPrompt request={request} />);

    const feedbackInput = screen.getByPlaceholderText(
      "No, and tell Codex what to do differently",
    );

    fireEvent.change(feedbackInput, {
      target: { value: "Use curl instead" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "deny",
        message: "Use curl instead",
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
    const approveOption = screen.getByRole("radio", { name: "Yes" });
    const prefixOption = screen.getByRole("radio", {
      name: /don't ask again/,
    });

    fireEvent.keyDown(outsideInput, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(outsideInput, { key: "Enter", code: "Enter" });

    expect(approveOption).toHaveAttribute("aria-checked", "true");
    expect(prefixOption).toHaveAttribute("aria-checked", "false");
    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });

  it("submits the arrow-selected feedback option when Enter is pressed", async () => {
    render(<AgentApprovalPrompt request={request} />);

    const prompt = screen.getByTestId("agent-approval-prompt");
    fireEvent.keyDown(prompt, { key: "ArrowDown", code: "ArrowDown" });
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
