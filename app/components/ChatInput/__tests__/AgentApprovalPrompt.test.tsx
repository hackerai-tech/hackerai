import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockSendToolApproval = jest.fn(() => Promise.resolve());
const mockOnRetryConnection = jest.fn();
const mockOnStop = jest.fn();
let mockSession: {
  chatId: string;
  sessionId: string;
  publicAccessToken: string;
} | null;

jest.mock("@/app/contexts/AgentApprovalContext", () => ({
  useAgentApproval: () => ({
    session: mockSession,
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

const renderPrompt = (props?: { hasConnectionError?: boolean }) =>
  render(
    <AgentApprovalPrompt
      request={request}
      hasConnectionError={props?.hasConnectionError}
      onRetryConnection={mockOnRetryConnection}
      onStop={mockOnStop}
    />,
  );

describe("AgentApprovalPrompt", () => {
  beforeEach(() => {
    mockSendToolApproval.mockClear();
    mockOnRetryConnection.mockClear();
    mockOnStop.mockClear();
    mockSession = {
      chatId: "approval-chat",
      sessionId: "agent-approval-session",
      publicAccessToken: "public-token",
    };
  });

  it("renders a compact approval card instead of selectable option rows", () => {
    renderPrompt();

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

  it("approves once when Enter activates the focused primary action", async () => {
    const user = userEvent.setup();
    renderPrompt();
    const allowButton = screen.getByRole("button", { name: "Allow once" });
    allowButton.focus();

    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
      }),
    );
    expect(allowButton).toHaveFocus();
  });

  it("does not approve when Enter is pressed on the page body", () => {
    renderPrompt();

    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" });

    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });

  it("approves once from the primary action", async () => {
    renderPrompt();

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
    renderPrompt();

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
        onRetryConnection={mockOnRetryConnection}
        onStop={mockOnStop}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "More approval options" }),
    ).not.toBeInTheDocument();
  });

  it("denies from the secondary action", async () => {
    renderPrompt();

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
        <AgentApprovalPrompt
          request={request}
          onRetryConnection={mockOnRetryConnection}
          onStop={mockOnStop}
        />
      </>,
    );

    fireEvent.keyDown(screen.getByLabelText("Outside input"), {
      key: "Enter",
      code: "Enter",
    });

    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["button", <button key="button">Outside button</button>],
    ["select", <select key="select" aria-label="Outside select" />],
    ["summary", <summary key="summary">Outside summary</summary>],
    [
      "contenteditable",
      <div key="contenteditable" contentEditable suppressContentEditableWarning>
        Outside editor
      </div>,
    ],
    [
      "interactive ARIA role",
      <div key="aria-button" role="button" tabIndex={0}>
        Outside ARIA button
      </div>,
    ],
  ])("does not capture Enter from an unrelated %s", (_name, element) => {
    const { container } = render(
      <>
        {element}
        <AgentApprovalPrompt
          request={request}
          onRetryConnection={mockOnRetryConnection}
          onStop={mockOnStop}
        />
      </>,
    );
    const target = container.firstElementChild as HTMLElement;

    fireEvent.keyDown(target, { key: "Enter", code: "Enter" });

    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });

  it("does not approve when an unrelated link is focused", () => {
    render(
      <>
        <a href="/help">Approval help</a>
        <AgentApprovalPrompt
          request={request}
          onRetryConnection={mockOnRetryConnection}
          onStop={mockOnStop}
        />
      </>,
    );
    const link = screen.getByRole("link", { name: "Approval help" });
    link.focus();

    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" });

    expect(link).toHaveFocus();
    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });

  it("does not approve from an unrelated noninteractive page target", () => {
    render(
      <>
        <div data-testid="outside-copy">Outside copy</div>
        <AgentApprovalPrompt
          request={request}
          onRetryConnection={mockOnRetryConnection}
          onStop={mockOnStop}
        />
      </>,
    );

    fireEvent.keyDown(screen.getByTestId("outside-copy"), {
      key: "Enter",
      code: "Enter",
    });

    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });

  it("requires one-time approval for file changes", async () => {
    render(
      <AgentApprovalPrompt
        request={{
          ...request,
          kind: "file",
          operation: "file_write",
          target: "/workspace/report.txt",
        }}
        onRetryConnection={mockOnRetryConnection}
        onStop={mockOnStop}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "More approval options" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    await waitFor(() =>
      expect(mockSendToolApproval).toHaveBeenCalledWith({
        approvalId: "approval-1",
        toolCallId: "tool-1",
        decision: "approve",
      }),
    );
  });

  it("shows reconnecting and stop controls without session credentials", () => {
    mockSession = null;
    renderPrompt();

    expect(
      screen.getByText("Reconnecting to the Agent approval session..."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow once" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));

    expect(mockOnStop).toHaveBeenCalledTimes(1);
  });

  it("shows retry and stop controls after reconnection fails", () => {
    mockSession = null;
    renderPrompt({ hasConnectionError: true });

    expect(
      screen.getByText("Could not reconnect to the Agent approval session."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(mockOnRetryConnection).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Stop agent" }),
    ).toBeInTheDocument();
  });

  it("does not submit modified Enter shortcuts", () => {
    renderPrompt();

    fireEvent.keyDown(document.body, {
      key: "Enter",
      code: "Enter",
      shiftKey: true,
    });

    expect(mockSendToolApproval).not.toHaveBeenCalled();
  });
});
