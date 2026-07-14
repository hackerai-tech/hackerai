import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const setAgentPermissionMode = jest.fn();
const captureAuthenticatedEvent = jest.fn();

jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    agentPermissionMode: "full_access",
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
    setAgentPermissionMode.mockClear();
    captureAuthenticatedEvent.mockClear();
  });

  it("captures permission mode changes before updating the selection", () => {
    render(<AgentPermissionSelector analyticsSurface="chat_input" />);

    fireEvent.click(screen.getByRole("button", { name: /full access/i }));
    fireEvent.click(
      screen.getByRole("button", {
        name: /ask for approval always ask before/i,
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
});
