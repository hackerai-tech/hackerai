jest.mock("@trigger.dev/sdk", () => ({
  runs: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    schedules: { unsettled: "unsettled", recordOutcome: "recordOutcome" },
  },
}));
import { reconcileScheduleRuns } from "../reconcile";
const mockRetrieve = jest.fn(),
  mockQuery = jest.fn(),
  mockMutation = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([{ id: "receipt", triggerRunId: "run" }]);
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
it("preserves an unknown outcome when a status request fails", async () => {
  mockRetrieve.mockRejectedValue(Error("unavailable"));
  await reconcileScheduleRuns();
  expect(mockMutation).not.toHaveBeenCalled();
});
it("does not label a running or waiting Agent completed", async () => {
  mockRetrieve.mockResolvedValue({ status: "WAITING" });
  await reconcileScheduleRuns();
  expect(mockMutation).not.toHaveBeenCalled();
});
