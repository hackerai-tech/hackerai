import { logUsageRecord } from "../actions";

const mockMutation = jest.fn();

jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("../convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation }),
}));

const usage: Parameters<typeof logUsageRecord>[0] = {
  usageSettlementId: "settlement-1",
  userId: "user-1",
  model: "x-ai/grok-4.6",
  type: "included",
  inputTokens: 100,
  outputTokens: 20,
  costDollars: 0.01,
  modelSelection: { selected: "hackerai-max", initial_model: "x-ai/grok-4.6" },
};

beforeEach(() => mockMutation.mockReset());

test("preserves the usage row when a previous Convex validator rejects selection metadata", async () => {
  mockMutation
    .mockRejectedValueOnce(
      new Error(
        "ArgumentValidationError: Object contains extra field `model_selection` that is not in the validator.",
      ),
    )
    .mockResolvedValueOnce(null);

  await expect(logUsageRecord(usage)).resolves.toEqual({ status: "persisted" });
  expect(mockMutation).toHaveBeenCalledTimes(2);
  const [[, initial], [, retry]] = mockMutation.mock.calls;
  expect(initial).toEqual({ ...retry, model_selection: usage.modelSelection });
  expect(retry).toMatchObject({
    usage_settlement_id: "settlement-1",
    cost_dollars: 0.01,
  });
  expect(retry).not.toHaveProperty("model_selection");
});

test("does not replay a usage write with an unknown outcome", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    mockMutation.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(logUsageRecord(usage)).resolves.toEqual({
      status: "failed",
      failureCategory: "write_failed",
    });
    expect(mockMutation).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});
