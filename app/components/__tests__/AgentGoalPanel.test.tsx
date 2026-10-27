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
let mockIsMobile = false;
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mockIsMobile }));
const mockOpenSidebar = jest.fn();
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({ openSidebar: mockOpenSidebar }),
}));
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
    mockIsMobile = false;
    mockOpenSidebar.mockClear();
    setMockQueryResult(undefined);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ enabled: true }) });
  });
  it.each([false, true])(
    "hides an achieved goal only after a newer saved user message (mobile: %s)",
    async (isMobile) => {
      mockIsMobile = isMobile;
      const achieved = {
        ...goal,
        state: "achieved",
        achievedAt: 2000,
        updatedAt: 2000,
      };
      setMockQueryResult(achieved);
      const panel = (latestSavedUserMessageAt?: number) => (
        <AgentGoalPanel
          chatId="chat"
          exists
          eligible
          idle
          send={jest.fn()}
          settings={settings}
          latestSavedUserMessageAt={latestSavedUserMessageAt}
        />
      );
      const { rerender, unmount } = render(panel(1000));
      expect(screen.getByRole("status")).toHaveTextContent("Goal achieved");
      // Unsaved drafts and failed optimistic sends don't advance this timestamp.
      rerender(panel(1000));
      expect(screen.getByRole("status")).toHaveTextContent("Goal achieved");
      rerender(panel(3000));
      expect(
        screen.queryByRole("region", { name: "Agent goal" }),
      ).not.toBeInTheDocument();
      unmount();
      const reloaded = render(panel(3000));
      expect(
        screen.queryByRole("region", { name: "Agent goal" }),
      ).not.toBeInTheDocument();
      setMockQueryResult({ ...achieved, _id: "next-goal", achievedAt: 4000 });
      reloaded.rerender(panel(3000));
      expect(screen.getByRole("status")).toHaveTextContent("Goal achieved");
      setMockQueryResult({ ...goal, state: "paused", updatedAt: 2000 });
      reloaded.rerender(panel(3000));
      expect(screen.getByRole("status")).toHaveTextContent("Paused goal");
      expect(fetch).not.toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.objectContaining({ method: "POST" }),
      );
      await act(async () => {});
    },
  );
  it("keeps a paused goal visible and enables Resume after the canceled run settles", async () => {
    const paused = { ...goal, state: "paused", maxRuns: 3, activeRunId: "r1" };
    setMockQueryResult(paused);
    const send = jest.fn().mockResolvedValue(undefined);
    const panel = (
      <AgentGoalPanel
        chatId="chat"
        exists
        eligible
        idle
        send={send}
        settings={settings}
      />
    );
    const { rerender } = render(panel);
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("Paused");
    expect(screen.getByText("Create marker")).toBeVisible();
    expect(screen.getByRole("button", { name: "Resume goal" })).toBeDisabled();
    setMockQueryResult({ ...paused, activeRunId: undefined });
    rerender(
      <AgentGoalPanel
        chatId="chat"
        exists
        eligible
        idle
        send={send}
        settings={settings}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Resume goal" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Resume goal: Create marker",
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            goal: { action: "resume", additionalRuns: 0 },
          }),
        }),
      ),
    );
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
      expect(send).toHaveBeenCalledWith(
        {
          text: "Resume goal: Create marker",
        },
        {
          body: {
            mode: "agent",
            sandboxPreference: "desktop",
            agentPermissionMode: "ask_approval",
            selectedModel: "standard",
            goal: { action: "resume", additionalRuns: 2 },
          },
        },
      ),
    );
  });
  it("does not carry an old goal's extra runs or reply into a replacement using the same saved row", async () => {
    setMockQueryResult({ ...goal, startedAt: 1000 });
    const send = jest.fn().mockResolvedValue(undefined);
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
    fireEvent.click(screen.getByRole("button", { name: "Add runs" }));
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Additional goal runs" }),
      {
        target: { value: "2" },
      },
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Goal reply" }), {
      target: { value: "Context for the old goal" },
    });
    // Starting again reuses the tombstoned row; query updates may skip the null state.
    setMockQueryResult({
      ...goal,
      state: "paused",
      objective: "New marker",
      startedAt: 2000,
      runs: 0,
      maxRuns: 3,
    });
    rerender(<AgentGoalPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        { text: "Resume goal: New marker" },
        expect.objectContaining({
          body: expect.objectContaining({
            goal: { action: "resume", additionalRuns: 0 },
          }),
        }),
      ),
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
    expect(screen.getByRole("button", { name: "Clear goal" })).toBeEnabled();
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
  it.each([false, true])(
    "shows completed goal details and saved evidence without stale progress (mobile: %s)",
    async (isMobile) => {
      mockIsMobile = isMobile;
      setMockQueryResult({
        ...goal,
        state: "achieved",
        reason: "Completion verified",
        progress: "Pending independent verification",
        evidence: [
          {
            criterion: 0,
            runId: "r1",
            messageId: "m1",
            explanation: "File read",
          },
        ],
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
      expect(screen.getByRole("status")).toHaveTextContent("Goal achieved");
      expect(screen.queryByText("Completion verified")).not.toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Show goal details" }),
      );
      expect(screen.getByText("Completion verified")).toBeVisible();
      expect(
        screen.getByRole("dialog", { name: "Goal achievement details" }),
      ).toHaveTextContent("Create marker");
      expect(screen.getByText("✓ Marker exists")).toBeVisible();
      fireEvent.click(screen.getByText("Verification and evidence"));
      expect(
        screen.getByRole("link", { name: "saved run evidence" }),
      ).toHaveAttribute("href", "/c/chat#message=m1");
      expect(
        screen.queryByText(/Pending independent verification/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Resume goal" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Edit goal" }),
      ).not.toBeInTheDocument();
      fireEvent.keyDown(
        screen.getByRole("dialog", { name: "Goal achievement details" }),
        { key: "Escape" },
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(
        screen.getByRole("button", { name: "Show goal details" }),
      ).toHaveFocus();
      fireEvent.click(
        screen.getByRole("button", { name: "Show goal details" }),
      );
      fireEvent.click(screen.getByText("Verification and evidence"));
      fireEvent.click(screen.getByRole("link", { name: "saved run evidence" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      if (isMobile)
        fireEvent.click(
          screen.getByRole("button", { name: "Show goal details" }),
        );
      fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
          "/api/agent-goal",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ chatId: "chat", action: "clear" }),
          }),
        ),
      );
      await act(async () => {});
    },
  );

  it.each(["running", "paused", "needs_input", "budget_exhausted"])(
    "keeps completion evidence hidden for an unfinished %s goal",
    async (state) => {
      setMockQueryResult({
        ...goal,
        state,
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
      fireEvent.click(
        screen.getByRole("button", { name: "Show goal details" }),
      );
      expect(
        screen.getByText(/Evidence saved, awaiting verification/),
      ).toBeVisible();
      expect(screen.queryByText(/✓/)).not.toBeInTheDocument();
      expect(
        screen.queryByText("Completion contract and evidence"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Verification and evidence"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "saved run evidence" }),
      ).not.toBeInTheDocument();
      await act(async () => {});
    },
  );

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

  it("has no permanent launcher when no goal exists", async () => {
    render(
      <AgentGoalPanel
        chatId="chat"
        exists={false}
        eligible
        idle
        send={jest.fn()}
        settings={settings}
      />,
    );
    await act(async () => {});
    expect(
      screen.queryByRole("region", { name: "Agent goal" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Set goal/ }),
    ).not.toBeInTheDocument();
  });
  it("opens the existing sidebar to edit while a run is active", async () => {
    setMockQueryResult({ ...goal, state: "running", activeRunId: "r1" });
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
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
    expect(mockOpenSidebar).toHaveBeenCalledWith({
      kind: "goal",
      chatId: "chat",
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.objectContaining({
          body: JSON.stringify({ chatId: "chat", action: "clear" }),
        }),
      ),
    );
  });
  it("keeps mobile controls behind a pill and closes them when opening the editor", async () => {
    mockIsMobile = true;
    setMockQueryResult({
      ...goal,
      state: "running",
      activeRunId: "run",
      startedAt: Date.now() - 5000,
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
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("Pursuing goal");
    expect(
      screen.queryByRole("button", { name: "Pause goal" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show goal controls" }));
    expect(
      screen.getByRole("dialog", { name: "Goal controls" }),
    ).toHaveTextContent("Create marker");
    expect(screen.getByRole("button", { name: "Pause goal" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
    expect(mockOpenSidebar).toHaveBeenCalledWith({
      kind: "goal",
      chatId: "chat",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Goal controls" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Show goal controls" }),
    ).toHaveFocus();
  });

  it("resumes a paused mobile goal from its popover and then dismisses it", async () => {
    mockIsMobile = true;
    setMockQueryResult({ ...goal, state: "paused", maxRuns: 3 });
    let finish!: () => void;
    const send = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Show goal controls" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({
            goal: { action: "resume", additionalRuns: 0 },
          }),
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Goal controls" }),
      ).not.toBeInTheDocument(),
    );
    await act(async () => finish());
  });

  it("focuses mobile controls on opening and restores the pill on Escape", async () => {
    mockIsMobile = true;
    setMockQueryResult({ ...goal, state: "paused", maxRuns: 3 });
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
    await act(async () => {});
    const trigger = screen.getByRole("button", { name: "Show goal controls" });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Details" })).toHaveFocus(),
    );
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Goal controls" }), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Goal controls" }),
      ).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it.each([false, true])(
    "freezes the saved timer across remount and resumes without the paused gap (mobile: %s)",
    async (isMobile) => {
      jest.useFakeTimers().setSystemTime(6000);
      mockIsMobile = isMobile;
      const panel = () => (
        <AgentGoalPanel
          chatId="chat"
          exists
          eligible
          idle
          send={jest.fn()}
          settings={settings}
        />
      );
      try {
        setMockQueryResult({
          ...goal,
          state: "paused",
          startedAt: 1000,
          updatedAt: 6000,
          elapsedMs: 5000,
        });
        const first = render(panel());
        await act(async () => {});
        expect(
          screen.getByLabelText(
            "Elapsed time 5s, excluding pauses and waiting",
          ),
        ).toBeVisible();
        act(() => jest.advanceTimersByTime(60000));
        expect(
          screen.getByLabelText(
            "Elapsed time 5s, excluding pauses and waiting",
          ),
        ).toBeVisible();
        first.unmount();
        const second = render(panel());
        await act(async () => {});
        expect(
          screen.getByLabelText(
            "Elapsed time 5s, excluding pauses and waiting",
          ),
        ).toBeVisible();
        setMockQueryResult({
          ...goal,
          state: "running",
          startedAt: 1000,
          updatedAt: 66000,
          elapsedMs: 5000,
          activeSince: 66000,
        });
        second.rerender(panel());
        act(() => jest.advanceTimersByTime(3000));
        expect(
          screen.getByLabelText(
            "Elapsed time 8s, excluding pauses and waiting",
          ),
        ).toBeVisible();
        second.unmount();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "rounds the saved completion duration like the message receipt (mobile: %s)",
    async (isMobile) => {
      mockIsMobile = isMobile;
      setMockQueryResult({
        ...goal,
        state: "achieved",
        startedAt: 1000,
        achievedAt: 65600,
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
      await act(async () => {});
      expect(screen.getByRole("status")).toHaveTextContent("Goal achieved");
      expect(
        screen.getByLabelText(
          "Elapsed time 1m 5s, excluding pauses and waiting",
        ),
      ).toBeVisible();
    },
  );
});
