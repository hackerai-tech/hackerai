import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const setAgentPermissionMode = jest.fn();
const captureAuthenticatedEvent = jest.fn();
let agentPermissionMode = "full_access";
const fetchMock = jest.fn();

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    agentPermissionMode,
    setAgentPermissionMode,
  }),
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent,
}));

const { AgentPermissionSelector } = jest.requireActual<
  typeof import("../AgentPermissionSelector")
>("../AgentPermissionSelector");

describe("AgentPermissionSelector", () => {
  beforeEach(() => {
    agentPermissionMode = "full_access";
    setAgentPermissionMode.mockClear();
    captureAuthenticatedEvent.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ available: true, phase: "shadow" }),
    });
    global.fetch = fetchMock as typeof fetch;
  });

  it("captures permission mode changes before updating the selection", async () => {
    render(<AgentPermissionSelector analyticsSurface="chat_input" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /full access/i }));
    fireEvent.click(
      screen.getByRole("button", {
        name: /ask for approval always ask before commands and file changes/i,
      }),
    );

    expect(captureAuthenticatedEvent).toHaveBeenCalledWith(
      "agent_permission_mode_changed",
      expect.objectContaining({
        mode: "agent",
        previous_agent_permission_mode: "full_access",
        agent_permission_mode: "ask_approval",
        surface: "chat_input",
        agent_permission_event_version: 1,
        $set: expect.objectContaining({
          agent_permission_mode: "ask_approval",
          last_agent_permission_mode_changed_at: expect.any(String),
        }),
      }),
    );
    expect(setAgentPermissionMode).toHaveBeenCalledWith("ask_approval");
  });

  it("reports each permission-mode transition from the currently selected mode", async () => {
    agentPermissionMode = "auto_review";
    const { rerender } = render(
      <AgentPermissionSelector analyticsSurface="chat_input" />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /approve for me/i }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /ask for approval always ask before commands and file changes/i,
      }),
    );
    expect(captureAuthenticatedEvent).toHaveBeenLastCalledWith(
      "agent_permission_mode_changed",
      expect.objectContaining({
        previous_agent_permission_mode: "auto_review",
        agent_permission_mode: "ask_approval",
      }),
    );

    agentPermissionMode = "ask_approval";
    rerender(<AgentPermissionSelector analyticsSurface="chat_input" />);
    fireEvent.click(
      screen.getByRole("button", { name: /^ask for approval$/i }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /full access run commands and edit files without asking/i,
      }),
    );
    expect(captureAuthenticatedEvent).toHaveBeenLastCalledWith(
      "agent_permission_mode_changed",
      expect.objectContaining({
        previous_agent_permission_mode: "ask_approval",
        agent_permission_mode: "full_access",
      }),
    );
  });

  it("offers Approve for me only for a server flag assignment", async () => {
    render(<AgentPermissionSelector analyticsSurface="chat_input" />);

    fireEvent.click(screen.getByRole("button", { name: /full access/i }));
    expect(
      await screen.findByRole("button", {
        name: /approve for me only ask for actions detected as potentially unsafe/i,
      }),
    ).toBeInTheDocument();
  });

  it("fails closed and hides Approve for me when the flag is unavailable", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ available: false }),
    });
    render(<AgentPermissionSelector analyticsSurface="chat_input" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /full access/i }));
    expect(screen.queryByText("Approve for me")).not.toBeInTheDocument();
    expect(screen.getAllByText("Full access")).not.toHaveLength(0);
  });

  it("moves a stale Auto review selection back to Ask for approval", async () => {
    agentPermissionMode = "auto_review";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ available: false }),
    });

    render(<AgentPermissionSelector analyticsSurface="chat_input" />);

    await waitFor(() =>
      expect(setAgentPermissionMode).toHaveBeenCalledWith("ask_approval"),
    );
  });

  it("moves a stale Auto review selection back when flag lookup fails", async () => {
    agentPermissionMode = "auto_review";
    fetchMock.mockRejectedValue(new Error("network unavailable"));

    render(<AgentPermissionSelector analyticsSurface="chat_input" />);

    await waitFor(() =>
      expect(setAgentPermissionMode).toHaveBeenCalledWith("ask_approval"),
    );
  });
});
