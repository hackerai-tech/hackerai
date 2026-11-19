jest.mock("@/lib/db/actions", () => ({
  getCurrentAgentEntitlementContext: jest.fn(),
  setActiveTriggerRun: jest.fn(),
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/app/posthog", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@trigger.dev/sdk", () => ({ runs: { retrieve: jest.fn() } }));
jest.mock("../analytics", () => ({ captureGoalLifecycle: jest.fn() }));
import { runs } from "@trigger.dev/sdk";
import { setActiveTriggerRun } from "@/lib/db/actions";
import { getConvexClient } from "@/lib/db/convex-client";
import { ChatSDKError } from "@/lib/errors";
import { captureGoalLifecycle } from "../analytics";
import type { GoalReconciliationStep } from "../reconciliation-diagnostics";
import { reconcileGoal } from "../server";

const query = jest.fn();
const mutation = jest.fn();
const retrieve = jest.mocked(runs.retrieve);
const clear = jest.mocked(setActiveTriggerRun);
const capture = jest.mocked(captureGoalLifecycle);
const originalKey = process.env.CONVEX_SERVICE_ROLE_KEY;
const activeGoal = { _id: "goal", state: "running", activeRunId: "run-1" };
const settledGoal = { _id: "goal", state: "paused" };
const reloadedGoal = { _id: "goal", state: "achieved" };
const failure = new Error("synthetic reconciliation failure");
const terminalRun = (status = "FAILED") =>
  ({ status, metadata: { chatId: "chat", userId: "owner" } }) as never;

beforeEach(() => {
  jest.resetAllMocks();
  process.env.CONVEX_SERVICE_ROLE_KEY = "synthetic-reconcile-key";
  jest
    .mocked(getConvexClient)
    .mockReturnValue({ query, mutation } as unknown as ReturnType<
      typeof getConvexClient
    >);
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
  else process.env.CONVEX_SERVICE_ROLE_KEY = originalKey;
});

const operationCounts = () => ({
  query: query.mock.calls.length,
  retrieve: retrieve.mock.calls.length,
  mutation: mutation.mock.calls.length,
  clear: clear.mock.calls.length,
  capture: capture.mock.calls.length,
});
const observe = async (
  onStep?: (step: GoalReconciliationStep) => void,
): Promise<{
  steps: GoalReconciliationStep[];
  outcome: PromiseSettledResult<unknown>;
}> => {
  const steps: GoalReconciliationStep[] = [];
  const [outcome] = await Promise.allSettled([
    reconcileGoal("chat", "owner", (step) => {
      steps.push(step);
      onStep?.(step);
    }),
  ]);
  return { steps, outcome };
};

describe("reconcileGoal step observation", () => {
  it.each([null, { _id: "goal", state: "paused" }])(
    "reads once and returns the saved goal without an active run (%j)",
    async (saved) => {
      query.mockResolvedValueOnce(saved);
      const { steps, outcome } = await observe();
      expect(outcome).toEqual({ status: "fulfilled", value: saved });
      expect(steps).toEqual(["get_goal"]);
      expect(operationCounts()).toEqual({
        query: 1,
        retrieve: 0,
        mutation: 0,
        clear: 0,
        capture: 0,
      });
    },
  );

  it("leaves an ongoing run attached without settling it", async () => {
    query.mockResolvedValueOnce(activeGoal);
    retrieve.mockResolvedValueOnce(terminalRun("EXECUTING"));
    const { steps, outcome } = await observe();
    expect(outcome).toEqual({ status: "fulfilled", value: activeGoal });
    expect(steps).toEqual(["get_goal", "retrieve_run"]);
    expect(retrieve).toHaveBeenCalledWith("run-1");
    expect(mutation).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("keeps the identity gate ahead of settlement", async () => {
    query.mockResolvedValueOnce(activeGoal);
    retrieve.mockResolvedValueOnce({
      status: "FAILED",
      metadata: { chatId: "chat", userId: "someone-else" },
    } as never);
    const { steps, outcome } = await observe();
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
      ChatSDKError,
    );
    expect(steps).toEqual(["get_goal", "retrieve_run"]);
    expect(mutation).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("settles a terminal run, records the lifecycle and returns the settled goal", async () => {
    query.mockResolvedValueOnce(activeGoal);
    retrieve.mockResolvedValueOnce(terminalRun("CANCELED"));
    mutation.mockResolvedValueOnce(settledGoal);
    const { steps, outcome } = await observe();
    expect(outcome).toEqual({ status: "fulfilled", value: settledGoal });
    expect((outcome as PromiseFulfilledResult<unknown>).value).toBe(
      settledGoal,
    );
    expect(steps).toEqual([
      "get_goal",
      "retrieve_run",
      "finish_goal",
      "clear_active_run",
      "capture_lifecycle",
    ]);
    expect(mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: "run-1",
        canceled: true,
        failed: false,
        usageExhausted: false,
      }),
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear.mock.calls[0][0]).toEqual({
      chatId: "chat",
      triggerRunId: null,
      approvalSessionId: null,
      expectedRunId: "run-1",
      clearApprovalPending: true,
    });
    expect(capture).toHaveBeenCalledWith(
      "reconciled",
      { userId: "owner", chatId: "chat", runId: "run-1" },
      settledGoal,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("reloads instead of recording a lifecycle when settlement was already committed", async () => {
    query.mockResolvedValueOnce(activeGoal).mockResolvedValueOnce(reloadedGoal);
    retrieve.mockResolvedValueOnce(terminalRun());
    mutation.mockResolvedValueOnce(null);
    const { steps, outcome } = await observe();
    expect((outcome as PromiseFulfilledResult<unknown>).value).toBe(
      reloadedGoal,
    );
    expect(steps).toEqual([
      "get_goal",
      "retrieve_run",
      "finish_goal",
      "clear_active_run",
      "reload_goal",
    ]);
    expect(capture).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  // Each failure names its own step, rethrows the same value and stops there.
  it.each<[GoalReconciliationStep, () => void, Record<string, number>]>([
    [
      "get_goal",
      () => query.mockRejectedValueOnce(failure),
      { query: 1, retrieve: 0, mutation: 0, clear: 0, capture: 0 },
    ],
    [
      "retrieve_run",
      () => {
        query.mockResolvedValueOnce(activeGoal);
        retrieve.mockRejectedValueOnce(failure);
      },
      { query: 1, retrieve: 1, mutation: 0, clear: 0, capture: 0 },
    ],
    [
      "finish_goal",
      () => {
        query.mockResolvedValueOnce(activeGoal);
        retrieve.mockResolvedValueOnce(terminalRun());
        mutation.mockRejectedValueOnce(failure);
      },
      { query: 1, retrieve: 1, mutation: 1, clear: 0, capture: 0 },
    ],
    [
      "clear_active_run",
      () => {
        query.mockResolvedValueOnce(activeGoal);
        retrieve.mockResolvedValueOnce(terminalRun());
        mutation.mockResolvedValueOnce(settledGoal);
        clear.mockRejectedValueOnce(failure);
      },
      { query: 1, retrieve: 1, mutation: 1, clear: 1, capture: 0 },
    ],
    [
      "capture_lifecycle",
      () => {
        query.mockResolvedValueOnce(activeGoal);
        retrieve.mockResolvedValueOnce(terminalRun());
        mutation.mockResolvedValueOnce(settledGoal);
        capture.mockRejectedValueOnce(failure);
      },
      { query: 1, retrieve: 1, mutation: 1, clear: 1, capture: 1 },
    ],
    [
      "reload_goal",
      () => {
        query.mockResolvedValueOnce(activeGoal).mockRejectedValueOnce(failure);
        retrieve.mockResolvedValueOnce(terminalRun());
        mutation.mockResolvedValueOnce(null);
      },
      { query: 2, retrieve: 1, mutation: 1, clear: 1, capture: 0 },
    ],
  ])(
    "attributes a %s failure without retrying or continuing",
    async (step, arrange, counts) => {
      arrange();
      const { steps, outcome } = await observe();
      expect(outcome).toEqual({ status: "rejected", reason: failure });
      expect((outcome as PromiseRejectedResult).reason).toBe(failure);
      expect(steps.at(-1)).toBe(step);
      expect(operationCounts()).toEqual(counts);
    },
  );

  it("keeps every read and write on an admission's own unbounded client", async () => {
    const admission = {
      client: {
        query: jest
          .fn()
          .mockResolvedValueOnce(activeGoal)
          .mockResolvedValueOnce(reloadedGoal),
        mutation: jest.fn().mockResolvedValueOnce(null),
      } as unknown as ReturnType<typeof getConvexClient>,
    };
    retrieve.mockResolvedValueOnce(terminalRun());
    await expect(
      reconcileGoal("chat", "owner", undefined, admission),
    ).resolves.toBe(reloadedGoal);
    // The shared client is never used, so another chat cannot hold this one.
    expect(getConvexClient).not.toHaveBeenCalled();
    expect(admission.client.query).toHaveBeenCalledTimes(2);
    expect(admission.client.mutation).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRunId: "run-1" }),
      admission,
    );
  });

  it.each(["settled", "finish_goal failure"])(
    "keeps the %s outcome and operations when the observer throws",
    async (path) => {
      const arrange = () => {
        query.mockResolvedValueOnce(activeGoal);
        retrieve.mockResolvedValueOnce(terminalRun());
        if (path === "settled") mutation.mockResolvedValueOnce(settledGoal);
        else mutation.mockRejectedValueOnce(failure);
      };
      arrange();
      const [unobserved] = await Promise.allSettled([
        reconcileGoal("chat", "owner"),
      ]);
      const unobservedCounts = operationCounts();
      jest.clearAllMocks();
      arrange();
      const { steps, outcome } = await observe(() => {
        throw new Error("observer unavailable");
      });
      expect(outcome).toEqual(unobserved);
      if (outcome.status === "fulfilled")
        expect(outcome.value).toBe(settledGoal);
      else expect(outcome.reason).toBe(failure);
      expect(operationCounts()).toEqual(unobservedCounts);
      expect(steps.length).toBeGreaterThan(1);
    },
  );
});
