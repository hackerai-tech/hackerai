import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
      screen.queryByRole("button", { name: /Set goal/ }),
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
    await act(async () => {});
    expect(
      screen.queryByRole("button", { name: "Resume goal" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add runs" }));
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
  it("allows Pause and Stop while a submitted goal stream is still pending", async () => {
    setMockQueryResult({ ...goal, state: "paused", runs: 0 });
    const send = jest.fn(() => new Promise<void>(() => {}));
    const props = {
      chatId: "chat",
      exists: true,
      eligible: true,
      idle: true,
      send,
      settings,
    };
    const { rerender } = render(<AgentGoalPanel {...props} />);
    await act(async () => {});
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Resume goal" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    setMockQueryResult({ ...goal, state: "running", activeRunId: "r1" });
    rerender(<AgentGoalPanel {...props} idle={false} />);
    expect(screen.getByRole("button", { name: "Pause goal" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop goal" })).toBeEnabled();
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
  it("keeps completed goals compact and shows the verified result without stale progress", async () => {
    setMockQueryResult({
      ...goal,
      state: "achieved",
      reason: "Completion verified",
      progress: "Pending independent verification",
      evidence: [{ criterion: 0, runId: "r1", explanation: "File read" }],
    });
    render(
      <AgentGoalPanel
        chatId="chat"
        exists
        eligible
        idle
        send={jest.fn()}
        settings={settings}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Completed");
    expect(screen.queryByText("Completion verified")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show goal details" }));
    expect(screen.getByText("Completion verified")).toBeVisible();
    expect(
      screen.queryByText(/Pending independent verification/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resume goal" }),
    ).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("does not mark saved evidence as verified for an unfinished goal", async () => {
    setMockQueryResult({
      ...goal,
      evidence: [{ criterion: 0, runId: "r1", explanation: "File read" }],
    });
    render(
      <AgentGoalPanel
        chatId="chat"
        exists
        eligible
        idle
        send={jest.fn()}
        settings={settings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show goal details" }));
    expect(
      screen.getByText(/Evidence saved, awaiting verification/),
    ).toBeVisible();
    expect(screen.queryByText(/✓/)).not.toBeInTheDocument();
    await act(async () => {});
  });

  it.each(["-1", "0.5", "8"])(
    "rejects an invalid additional budget of %s before sending",
    async (value) => {
      setMockQueryResult(goal);
      const send = jest.fn();
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
      fireEvent.click(screen.getByRole("button", { name: "Add runs" }));
      fireEvent.change(
        screen.getByRole("spinbutton", { name: "Additional goal runs" }),
        { target: { value } },
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Choose a whole number from 1 to 7",
      );
      expect(
        screen.queryByRole("button", { name: "Resume goal" }),
      ).not.toBeInTheDocument();
      expect(send).not.toHaveBeenCalled();
      await act(async () => {});
    },
  );

  it("validates each criterion before starting and preserves the dialog draft", async () => {
    const send = jest.fn();
    render(
      <AgentGoalPanel
        chatId="chat"
        exists={false}
        eligible
        idle
        send={send}
        settings={settings}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Set goal/ }));
    expect(
      screen.getByRole("dialog", { name: "Set an Agent goal" }),
    ).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Goal objective" }), {
      target: { value: "Create marker" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Goal success criteria" }),
      { target: { value: "x".repeat(1001) } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Start goal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "1,000 characters each",
    );
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: /Set goal/ }));
    expect(screen.getByRole("textbox", { name: "Goal objective" })).toHaveValue(
      "Create marker",
    );
  });
});
