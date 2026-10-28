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
    setMockQueryResult(undefined);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ enabled: true }) });
  });
  it.each(["Clear goal", "Pause goal"])(
    "saves the running response before %s and aborts when stopping fails",
    async (name) => {
      setMockQueryResult({
        ...goal,
        state: "running",
        activeRunId: "run",
        generation: 4,
      });
      let settle!: (result: boolean) => void;
      const stop = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            settle = resolve;
          }),
      );
      render(
        <AgentGoalPanel
          chatId="chat"
          exists
          eligible
          idle={false}
          send={jest.fn()}
          settings={settings}
          stopRunBeforeControl={stop}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name, exact: true }));
      expect(stop).toHaveBeenCalledWith("run");
      expect(fetch).not.toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.objectContaining({ method: "POST" }),
      );
      await act(async () => settle(false));
      expect(fetch).not.toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.objectContaining({ method: "POST" }),
      );
      fireEvent.click(screen.getByRole("button", { name, exact: true }));
      await act(async () => settle(true));
      expect(fetch).toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.objectContaining({
          body: JSON.stringify({
            chatId: "chat",
            action: name === "Clear goal" ? "clear" : "pause",
            generation: 4,
          }),
        }),
      );
    },
  );
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
            goal: { action: "resume" },
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
  it("resumes legacy capped goals without extra runs and restores saved settings", async () => {
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
    expect(screen.queryByText(/runs used/)).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
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
            goal: { action: "resume" },
          },
        },
      ),
    );
  });
  it("does not carry an old goal's reply into a replacement using the same saved row", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Show goal details" }));
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
            goal: { action: "resume" },
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

  it.each([3, 8, 100])(
    "allows resume beyond former run limits (%s)",
    async (runs) => {
      setMockQueryResult({ ...goal, state: "paused", runs, maxRuns: 3 });
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
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Resume goal" }),
        ).toBeEnabled(),
      );
      expect(screen.queryByText(/runs used|Add runs/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Resume goal" }));
      await waitFor(() => expect(send).toHaveBeenCalled());
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
  it.each([false, true])(
    "pauses and saves before loading the composer (mobile=%s)",
    async (mobile) => {
      mockIsMobile = mobile;
      const savedGoal = {
        ...goal,
        generation: 4,
        state: "running",
        activeRunId: "run",
        startedAt: Date.now() - 5000,
      };
      setMockQueryResult(savedGoal);
      const stop = jest.fn().mockResolvedValue(false);
      const loaded = jest.fn();
      const onEdit = jest.fn(async (value, prepare) => {
        if (!(await prepare())) return false;
        loaded(value);
        return true;
      });
      render(
        <AgentGoalPanel
          chatId="chat"
          exists
          eligible
          idle={false}
          send={jest.fn()}
          settings={settings}
          stopRunBeforeControl={stop}
          onEdit={onEdit}
        />,
      );
      await act(async () => {});
      if (mobile)
        fireEvent.click(
          screen.getByRole("button", { name: "Show goal controls" }),
        );
      fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
      await waitFor(() => expect(stop).toHaveBeenCalledWith("run"));
      expect(loaded).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.objectContaining({ method: "POST" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Edit goal" })).toBeEnabled(),
      );
      stop.mockResolvedValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
      await waitFor(() => expect(loaded).toHaveBeenCalledWith(savedGoal));
      expect(fetch).toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.objectContaining({
          body: JSON.stringify({
            chatId: "chat",
            action: "pause",
            generation: 4,
          }),
        }),
      );
      if (mobile)
        await waitFor(() =>
          expect(
            screen.queryByRole("dialog", { name: "Goal controls" }),
          ).not.toBeInTheDocument(),
        );
    },
  );

  it.each([false, true])(
    "allows an achieved goal to be edited again (mobile=%s)",
    async (mobile) => {
      mockIsMobile = mobile;
      const savedGoal = { ...goal, state: "achieved", generation: 7 };
      setMockQueryResult(savedGoal);
      const loaded = jest.fn();
      const onEdit = jest.fn(async (value, prepare) => {
        expect(prepare()).toBe(true);
        loaded(value);
        return true;
      });
      render(
        <AgentGoalPanel
          chatId="chat"
          exists
          eligible
          idle
          send={jest.fn()}
          settings={settings}
          onEdit={onEdit}
        />,
      );
      await act(async () => {});
      if (mobile)
        fireEvent.click(
          screen.getByRole("button", { name: "Show goal details" }),
        );
      fireEvent.click(screen.getByRole("button", { name: "Edit goal" }));
      await waitFor(() => expect(loaded).toHaveBeenCalledWith(savedGoal));
      expect(fetch).not.toHaveBeenCalledWith(
        "/api/agent-goal",
        expect.objectContaining({ method: "POST" }),
      );
    },
  );

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
            goal: { action: "resume" },
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

  it("hosts the mobile accessory beside the pill only while it fits", async () => {
    const observers: ResizeObserverCallback[] = [];
    const originalResizeObserver = Object.getOwnPropertyDescriptor(
      globalThis,
      "ResizeObserver",
    );
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
    let pillRight = 200;
    const rectSpy = jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const right = this.matches('section[aria-label="Agent goal"]')
          ? 288
          : pillRight;
        return { right } as DOMRect;
      });
    const resize = () =>
      act(() =>
        observers.forEach((callback) => callback([], {} as ResizeObserver)),
      );
    const onInline = jest.fn();
    const panel = (latestSavedUserMessageAt?: number) => (
      <AgentGoalPanel
        chatId="chat"
        exists
        eligible
        idle
        send={jest.fn()}
        settings={settings}
        latestSavedUserMessageAt={latestSavedUserMessageAt}
        mobileAccessory={<button type="button">Accessory</button>}
        onMobileAccessoryInlineChange={onInline}
      />
    );
    try {
      mockIsMobile = true;
      setMockQueryResult({ ...goal, state: "paused", startedAt: 1000 });
      const { rerender, unmount } = render(panel());
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Accessory" })).toBeVisible();
      expect(onInline).toHaveBeenLastCalledWith(true);
      // The pill stays the centered trigger; the accessory doesn't replace it.
      expect(
        screen.getByRole("button", { name: "Show goal controls" }),
      ).toBeVisible();

      // A longer label or timer leaves less than 48px: fall back.
      pillRight = 250;
      resize();
      expect(
        screen.queryByRole("button", { name: "Accessory" }),
      ).not.toBeInTheDocument();
      expect(onInline).toHaveBeenLastCalledWith(false);

      pillRight = 240;
      resize();
      expect(screen.getByRole("button", { name: "Accessory" })).toBeVisible();

      // Achieved goals keep hosting it until a newer saved user message.
      setMockQueryResult({
        ...goal,
        state: "achieved",
        achievedAt: 2000,
        updatedAt: 2000,
      });
      rerender(panel(1000));
      expect(screen.getByRole("status")).toHaveTextContent("Goal achieved");
      expect(screen.getByRole("button", { name: "Accessory" })).toBeVisible();
      expect(onInline).toHaveBeenLastCalledWith(true);
      rerender(panel(3000));
      expect(
        screen.queryByRole("button", { name: "Accessory" }),
      ).not.toBeInTheDocument();
      expect(onInline).toHaveBeenLastCalledWith(false);

      setMockQueryResult({ ...goal, state: "paused" });
      rerender(panel());
      expect(onInline).toHaveBeenLastCalledWith(true);
      unmount();
      expect(onInline).toHaveBeenLastCalledWith(false);

      // Desktop never hosts it, whatever the measured space.
      onInline.mockClear();
      mockIsMobile = false;
      render(panel());
      await act(async () => {});
      expect(
        screen.queryByRole("button", { name: "Accessory" }),
      ).not.toBeInTheDocument();
      expect(onInline).not.toHaveBeenCalled();
    } finally {
      rectSpy.mockRestore();
      if (originalResizeObserver)
        Object.defineProperty(
          globalThis,
          "ResizeObserver",
          originalResizeObserver,
        );
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

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
