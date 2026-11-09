jest.mock("@trigger.dev/sdk", () => ({
  runs: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    schedules: {
      unsettled: "unsettled",
      recordOutcome: "recordOutcome",
      abandonedDispatches: "abandoned",
      failDispatcher: "fail",
      recoverUncertainStarts: "recover",
    },
  },
}));
import { reconcileScheduleRuns } from "../reconcile";
const mockRetrieve = jest.fn(),
  mockQuery = jest.fn(),
  mockMutation = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation((fn) =>
    Promise.resolve(
      fn === "unsettled" ? [{ id: "receipt", triggerRunId: "run" }] : [],
    ),
  );
});
it.each([
  ["COMPLETED", "finished"],
  ["FAILED", "failed"],
  ["CANCELED", "canceled"],
  ["TIMED_OUT", "failed"],
])("records actual %s terminal state", async (status, outcome) => {
  mockRetrieve.mockResolvedValue({ status });
  await reconcileScheduleRuns("owner");
  expect(mockMutation).toHaveBeenCalledWith(
    "recordOutcome",
    expect.objectContaining({
      id: "receipt",
      triggerRunId: "run",
      status: outcome,
    }),
  );
});
it.each([
  [
    "handled rate limit",
    {
      metadata: { status: "rate_limited", blockedCode: "rate_limit:chat" },
      tags: ["rate_limited", "blocked_code_rate_limit_chat"],
    },
  ],
  ["rate-limit metadata", { metadata: { status: "rate_limited" } }],
  ["blocked-code tag", { tags: ["blocked_code_rate_limit_chat"] }],
  ["rate-limit tag", { tags: ["rate_limited"] }],
  ["user-correctable metadata", { metadata: { status: "user_correctable" } }],
  ["offline metadata", { metadata: { status: "reconnect_required" } }],
  ["missing-chat metadata", { metadata: { status: "chat_not_found" } }],
  ["failure metadata", { metadata: { status: "failed" } }],
  [
    "user-correctable tag",
    { tags: ["user_correctable_subscription_required"] },
  ],
])("records a completed Agent's %s as failed", async (_reason, terminal) => {
  // agent-long returns normally after emitting these handled terminal errors.
  mockRetrieve.mockResolvedValue({ status: "COMPLETED", ...terminal });
  await reconcileScheduleRuns("owner");
  expect(mockMutation).toHaveBeenCalledWith(
    "recordOutcome",
    expect.objectContaining({
      id: "receipt",
      triggerRunId: "run",
      status: "failed",
    }),
  );
});
it("waits for a blocked Agent to finish before settling its receipt", async () => {
  mockRetrieve.mockResolvedValue({
    status: "EXECUTING",
    metadata: { status: "rate_limited" },
    tags: ["rate_limited", "blocked_code_rate_limit_chat"],
  });
  await reconcileScheduleRuns("owner");
  expect(mockMutation).toHaveBeenCalledWith(
    "recordOutcome",
    expect.objectContaining({ status: "pending" }),
  );
});
it("preserves an unknown outcome when a status request fails", async () => {
  mockRetrieve.mockRejectedValue(Error("unavailable"));
  await reconcileScheduleRuns();
  expect(mockMutation).toHaveBeenCalledWith(
    "recordOutcome",
    expect.objectContaining({ status: "unconfirmed" }),
  );
});
it("does not label a running or waiting Agent completed", async () => {
  mockRetrieve.mockResolvedValue({ status: "WAITING" });
  await reconcileScheduleRuns();
  expect(mockMutation).toHaveBeenCalledWith(
    "recordOutcome",
    expect.objectContaining({ status: "pending" }),
  );
});
