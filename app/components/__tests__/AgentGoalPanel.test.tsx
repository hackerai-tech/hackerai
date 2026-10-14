import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentGoalPanel } from "../AgentGoalPanel";
import { setMockQueryResult } from "@/__mocks__/convex-react";
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
const settings = {
  sandboxPreference: "e2b",
  agentPermissionMode: "full_access",
  selectedModel: "auto",
};
const goal = {
  _id: "goal",
  state: "budget_exhausted",
  objective: "Create marker",
  criteria: ["Marker exists"],
  evidence: [],
  runs: 1,
  maxRuns: 1,
  progress: "Created file",
  reason: "Budget exhausted",
  sandboxPreference: "desktop",
  permissionMode: "ask_approval",
  selectedModel: "standard",
};
describe("goal controls", () => {
  beforeEach(() => {
    setMockQueryResult(undefined);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ enabled: true }) });
  });
  it("offers goals only after eligibility and flag checks", async () => {
    render(
      <AgentGoalPanel
        chatId="chat"
        exists={false}
        eligible={false}
        idle
        send={jest.fn()}
        settings={settings}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Set goal" }),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires explicit extra runs and restores the saved execution settings", async () => {
    setMockQueryResult(goal);
    const send = jest.fn().mockResolvedValue(undefined);
    render(
      <AgentGoalPanel
        chatId="chat"
        exists
        eligible
        idle
        send={send}
        settings={settings}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Resume goal" }),
    ).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Additional goal runs" }),
      { target: { value: "2" } },
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Resume goal" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.any(Object), {
        body: {
          mode: "agent",
          sandboxPreference: "desktop",
          agentPermissionMode: "ask_approval",
          selectedModel: "standard",
          goal: { action: "resume", additionalRuns: 2 },
        },
      }),
    );
  });
  it("preserves pause and stop controls when the feature has been disabled", async () => {
    setMockQueryResult({ ...goal, state: "running", activeRunId: "r1" });
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: false, state: "paused" }),
    });
    render(
      <AgentGoalPanel
        chatId="chat"
        exists
        eligible
        idle={false}
        send={jest.fn()}
        settings={settings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ chatId: "chat", action: "pause" }),
        }),
      ),
    );
  });
});
