jest.mock("@/lib/schedules/local-execution", () => ({
  findScheduledConnection: (...args: unknown[]) => mockLocalConnection(...args),
}));
jest.mock("@trigger.dev/sdk", () => ({
  schemaTask: (x: unknown) => x,
  schedules: { task: (x: unknown) => x },
  tasks: { trigger: jest.fn() },
}));
jest.mock("next/server", () => ({
  NextRequest: class {
    body: string;
    constructor(_url: string, init: { body: string }) {
      this.body = init.body;
    }
    async json() {
      return JSON.parse(this.body);
    }
  },
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/lib/db/actions", () => ({
  getCurrentAgentEntitlementContext: (...args: unknown[]) =>
    mockEntitlement(...args),
}));
jest.mock("@/lib/api/agent-trigger-route", () => ({
  createAgentTriggerPost: (config: unknown) => {
    mockIdentityConfig = config;
    return mockStart;
  },
}));
jest.mock("@/lib/schedules/access", () => ({
  canUseSchedules: (...args: unknown[]) => mockAllowed(...args),
}));
jest.mock("@/lib/schedules/reconcile", () => ({
  reconcileScheduleRuns: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    schedules: {
      getForDispatch: "get",
      claim: "claim",
      finishDispatch: "finish",
      failDispatcher: "fail",
      due: "due",
      beginDispatch: "begin",
      queuedManual: "queued",
    },
  },
}));
import { scheduledAgentRun, dispatchAgentSchedules } from "../schedules";
import { reconcileScheduleRuns } from "@/lib/schedules/reconcile";
import { tasks } from "@trigger.dev/sdk";
const mockLocalConnection = jest.fn();
const mockQuery = jest.fn(),
  mockMutation = jest.fn(),
  mockEntitlement = jest.fn(),
  mockAllowed = jest.fn(),
  mockStart = jest.fn();
let mockIdentityConfig: any;
const schedule = {
  userId: "owner",
  organizationId: "org",
  revision: 1,
  enabled: true,
  definition: {
    name: "test",
    prompt: "Synthetic instructions",
    model: "max",
    timing: { type: "interval", minutes: 15 },
  },
};
const run = (payload: unknown = { scheduleId: "s", revision: 1, at: 100 }) =>
  (scheduledAgentRun as any).run(payload, { ctx: { run: { id: "dispatch" } } });
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue(schedule);
  mockMutation.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === "claim"
        ? { id: "receipt", chatId: "stable-chat" }
        : fn === "begin"
          ? true
          : null,
    ),
  );
  mockEntitlement.mockResolvedValue({
    subscription: "pro",
    organizationId: "org",
  });
  mockAllowed.mockResolvedValue(true);
  mockStart.mockResolvedValue({
    ok: true,
    json: async () => ({ runId: "child" }),
  });
});
it("uses current entitlement and the normal Agent start with immutable cloud settings", async () => {
  await run();
  expect(mockEntitlement).toHaveBeenCalledWith({
    userId: "owner",
    organizationId: "org",
  });
  expect(await mockIdentityConfig.resolveIdentity()).toEqual({
    userId: "owner",
    emailVerified: true,
    subscription: "pro",
    organizationId: "org",
  });
  const body = await mockStart.mock.calls[0][0].json();
  expect(body).toMatchObject({
    chatId: "stable-chat",
    agentRunRequestId: "receipt",
    sandboxPreference: "e2b",
    agentPermissionMode: "full_access",
    selectedModel: "hackerai-max",
  });
  expect(body.messages[0].parts[0].text).toBe(schedule.definition.prompt);
});
it("dispatches due and queued work even when reconciliation fails", async () => {
  (reconcileScheduleRuns as jest.Mock).mockRejectedValueOnce(
    Error("unavailable"),
  );
  mockQuery.mockImplementation(async (fn) =>
    fn === "due"
      ? [{ id: "s", revision: 1, at: 100 }]
      : [{ id: "receipt", scheduleId: "m", revision: 2, requestId: "request" }],
  );
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await (dispatchAgentSchedules as any).run();
    expect(tasks.trigger).toHaveBeenCalledWith(
      "scheduled-agent-run",
      { scheduleId: "s", revision: 1, at: 100 },
      expect.any(Object),
    );
    expect(tasks.trigger).toHaveBeenCalledWith(
      "scheduled-agent-run",
      expect.objectContaining({
        scheduleId: "m",
        manual: true,
        receiptId: "receipt",
      }),
      expect.any(Object),
    );
  } finally {
    log.mockRestore();
  }
});
it("records lost eligibility without starting a child", async () => {
  mockEntitlement.mockResolvedValue({ subscription: "free" });
  mockAllowed.mockResolvedValue(false);
  expect(await run()).toEqual({ status: "unavailable" });
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockMutation).toHaveBeenCalledWith(
    "finish",
    expect.objectContaining({ status: "skipped" }),
  );
});
it("fences an edit or pause that occurs while authorization is checked", async () => {
  mockQuery
    .mockResolvedValueOnce(schedule)
    .mockResolvedValueOnce({ ...schedule, revision: 2, enabled: false });
  expect(await run()).toEqual({ status: "stale" });
  expect(mockStart).not.toHaveBeenCalled();
});
it("does not start again when another dispatcher already claimed the occurrence", async () => {
  mockMutation.mockResolvedValue(null);
  expect(await run()).toEqual({ status: "skipped" });
  expect(mockStart).not.toHaveBeenCalled();
});
it("records start failures without claiming Agent completion", async () => {
  mockStart.mockResolvedValue({ ok: false, status: 429 });
  expect(await run()).toEqual({ status: "failed" });
  expect(mockMutation).toHaveBeenCalledWith(
    "finish",
    expect.objectContaining({
      status: "failed",
      detail: expect.stringContaining("Usage limit"),
    }),
  );
});

const execution = {
  type: "local",
  preference: "environment:12345678-1234-4123-8123-123456789abc",
  name: "Lab",
  workingDirectory: "/tmp/lab",
};
it("starts local work with the exact environment and trusted folder snapshot", async () => {
  mockQuery.mockResolvedValue({
    ...schedule,
    definition: { ...schedule.definition, execution },
  });
  mockLocalConnection.mockResolvedValue({ connectionId: "live-session" });
  await run({ scheduleId: "s", revision: 1, at: Date.now() });
  expect(mockLocalConnection).toHaveBeenCalledWith(
    "owner",
    execution.preference,
  );
  expect((await mockStart.mock.calls[0][0].json()).sandboxPreference).toBe(
    execution.preference,
  );
  expect(mockIdentityConfig.scheduledLocalExecution).toEqual(execution);
});
it.each([null, "unavailable"])(
  "records a missed local start without any Agent or cloud fallback (%s)",
  async (state) => {
    mockQuery.mockResolvedValue({
      ...schedule,
      definition: { ...schedule.definition, execution },
    });
    if (state)
      mockLocalConnection.mockRejectedValue(Error("relay unavailable"));
    else mockLocalConnection.mockResolvedValue(null);
    await run({ scheduleId: "s", revision: 1, at: Date.now() });
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockMutation).toHaveBeenCalledWith(
      "finish",
      expect.objectContaining({
        status: "skipped",
        detail: expect.stringContaining("Missed:"),
      }),
    );
  },
);
it("does not catch up a stale local occurrence after a dispatcher outage", async () => {
  mockQuery.mockResolvedValue({
    ...schedule,
    definition: { ...schedule.definition, execution },
  });
  mockLocalConnection.mockResolvedValue({ connectionId: "live-session" });
  await run({ scheduleId: "s", revision: 1, at: Date.now() - 180000 });
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockLocalConnection).not.toHaveBeenCalled();
});
