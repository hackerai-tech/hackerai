jest.mock("@/lib/db/actions", () => ({
  getCurrentAgentEntitlementContext: jest.fn(),
}));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/app/posthog", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/posthog/flag-assignment", () => ({
  getPostHogFlagWithoutExposure: jest.fn(),
}));
jest.mock("../analytics", () => ({ captureGoalLifecycle: jest.fn() }));
import { getConvexClient } from "@/lib/db/convex-client";
import { finishGoalRun } from "../server";

const payload = {
  userId: "owner",
  chatId: "chat",
  subscription: "pro" as const,
  goalGeneration: 2,
};
const outcome = {
  canceled: false,
  failed: false,
  usageExhausted: false,
  messageId: "response",
  messageIds: ["response", "recovered"],
  judgment: { verdict: "done" as const, reason: "Verified" },
};
const mutation = jest.fn();
const originalKey = process.env.CONVEX_SERVICE_ROLE_KEY;
beforeEach(() => {
  jest.useFakeTimers();
  jest.resetAllMocks();
  process.env.CONVEX_SERVICE_ROLE_KEY = "test-service-key";
  jest
    .mocked(getConvexClient)
    .mockReturnValue({ mutation } as unknown as ReturnType<
      typeof getConvexClient
    >);
});
afterEach(() => {
  jest.useRealTimers();
  if (originalKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
  else process.env.CONVEX_SERVICE_ROLE_KEY = originalKey;
});
test("retries settlement without dropping the verified outcome or response ownership", async () => {
  const savedGoal = {
    _id: "goal",
    chatId: "chat",
    state: "achieved",
    runs: 1,
    evidence: [],
  };
  mutation
    .mockRejectedValueOnce(new Error("temporary transport failure"))
    .mockResolvedValue(savedGoal);
  const result = finishGoalRun(payload, "run-1", outcome);
  const assertion = expect(result).resolves.toEqual(savedGoal);
  await jest.runAllTimersAsync();
  await assertion;
  expect(mutation).toHaveBeenCalledTimes(2);
  for (const [, args] of mutation.mock.calls)
    expect(args).toEqual(
      expect.objectContaining({
        ...outcome,
        runId: "run-1",
        userId: "owner",
        chatId: "chat",
      }),
    );
});
test("stops after bounded failures and preserves the persistence error", async () => {
  mutation.mockRejectedValue(new Error("persistence unavailable"));
  const assertion = expect(
    finishGoalRun(payload, "run-1", outcome),
  ).rejects.toThrow("persistence unavailable");
  await jest.runAllTimersAsync();
  await assertion;
  expect(mutation).toHaveBeenCalledTimes(3);
});
test("does not retry an already settled or superseded run", async () => {
  mutation.mockResolvedValue(null);
  await expect(finishGoalRun(payload, "run-1", outcome)).resolves.toBeNull();
  expect(mutation).toHaveBeenCalledTimes(1);
});
