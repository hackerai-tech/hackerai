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
  operation: "terminal_execute" as const,
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
        name: /Yes, and don't ask again for "ping -c 4 hackerone.com" in this chat/,
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

  it("keeps Skip and Submit inline with the feedback option row", () => {
    render(<AgentApprovalPrompt request={request} />);

    const feedbackRow = screen.getByTestId("agent-approval-feedback-row");
    const actions = screen.getByTestId("agent-approval-actions");

    expect(actions.previousElementSibling).toBe(feedbackRow);
    expect(actions).toContainElement(
      screen.getByRole("button", { name: "Skip" }),
    );
    expect(actions).toContainElement(
      screen.getByRole("button", { name: /Submit/ }),
    );
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
        targetPrefix: '["ping","-c","4","hackerone.com"]',
      }),
    );
  });

  it("does not offer reuse for a chained terminal command", () => {
    render(
      <AgentApprovalPrompt
        request={{
          ...request,
          target: "npm test && npm publish",
        }}
      />,
    );

    expect(
      screen.queryByRole("radio", { name: /don't ask again/ }),
    ).not.toBeInTheDocument();
  });

  it("labels and submits an exact PTY session and action scope", async () => {
    render(
      <AgentApprovalPrompt
        request={{
          ...request,
          operation: "terminal_interact",
          title: "The agent wants to interact with this terminal session.",
          target: "send to a1b2c3d4: yes\n",
        }}
      />,
    );

    const sessionOption = screen.getByRole("radio", {
      name: /don't ask again for send actions in terminal session a1b2c3d4 during this run/,
    });
    fireEvent.keyDown(sessionOption, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
        grant: "target_prefix",
        targetKind: "terminal_interaction",
        targetPrefix: "send:a1b2c3d4",
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
        targetPrefix: '["ping","-c","4","hackerone.com"]',
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

  it("submits typed feedback once when Enter is pressed in the feedback input", async () => {
    render(<AgentApprovalPrompt request={request} />);

    const feedbackInput = screen.getByPlaceholderText(
      "No, and tell Codex what to do differently",
    );

    fireEvent.focus(feedbackInput);
    expect(screen.getByTestId("agent-approval-feedback-row")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.change(feedbackInput, {
      target: { value: "Use curl instead" },
    });
    fireEvent.keyDown(feedbackInput, {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() => {
      expect(mockSendToolApproval).toHaveBeenCalledTimes(1);
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "deny",
        message: "Use curl instead",
      });
    });
  });

  it("preserves modified Enter behavior in the feedback input", () => {
    render(<AgentApprovalPrompt request={request} />);

    const feedbackInput = screen.getByPlaceholderText(
      "No, and tell Codex what to do differently",
    );

    fireEvent.focus(feedbackInput);
    fireEvent.change(feedbackInput, {
      target: { value: "Use curl instead" },
    });
    fireEvent.keyDown(feedbackInput, {
      key: "Enter",
      code: "Enter",
      shiftKey: true,
    });

    expect(mockSendToolApproval).not.toHaveBeenCalled();
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
