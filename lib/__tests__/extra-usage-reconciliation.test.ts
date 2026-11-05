import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { deductFromBalance, deductFromTeamBalance } from "../extra-usage";

const mockAction = jest.fn();
const mockQuery = jest.fn();
const mockMutation = jest.fn();
const readSignals: AbortSignal[] = [];
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: (signal?: AbortSignal) => {
    if (signal) readSignals.push(signal);
    return { action: mockAction, query: mockQuery, mutation: mockMutation };
  },
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { error: jest.fn() } }));

type Receipt = NonNullable<
  FunctionReturnType<typeof api.settlementReceipts.getForBackend>
>;
const operationId = "wallet-v1:synthetic-reconciliation:step:1";
const userId = "synthetic-user";
const settlementId = "synthetic-reconciliation";
const organizationId = "synthetic-org";
const result = {
  success: true,
  newBalanceDollars: 0.012,
  insufficientFunds: false,
  monthlyCapExceeded: false,
  autoReloadTriggered: false,
};
const unknown = {
  success: false,
  newBalanceDollars: 0,
  insufficientFunds: false,
  monthlyCapExceeded: false,
  outcomeUnknown: true,
};
function receipt(team: boolean): Receipt {
  return {
    operation_id: operationId,
    user_id: userId,
    ...(team && { organization_id: organizationId }),
    usage_settlement_id: settlementId,
    amount_points: 20,
    status: "completed",
    created_at: 1,
    completed_at: 2,
    result: { ...result, ...(team && { memberDisabled: false }) },
    debits: [
      {
        sequence: 0,
        outcome: "applied",
        previous_balance_points: 100,
        new_balance_points: 80,
        created_at: 1,
        result: { ...result, newBalancePoints: 80 },
      },
    ],
  };
}
function deduct(team: boolean) {
  return team
    ? deductFromTeamBalance(
        organizationId,
        userId,
        20,
        settlementId,
        operationId,
      )
    : deductFromBalance(userId, 20, settlementId, operationId);
}

beforeEach(() => {
  jest.resetAllMocks();
  readSignals.length = 0;
  mockAction.mockRejectedValue(new TypeError("fetch failed"));
  mockQuery.mockResolvedValue(null);
});
afterEach(() => jest.useRealTimers());

describe.each([false, true])("receipt reconciliation (team=%s)", (team) => {
  it("recovers the completed saved result without sending another action or mutation", async () => {
    const saved = receipt(team);
    mockQuery.mockResolvedValue(saved);
    await expect(deduct(team)).resolves.toEqual(saved.result);
    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual({
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY,
      operation_id: operationId,
      user_id: userId,
      ...(team && { organization_id: organizationId }),
    });
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it.each(["missing", "pending-empty", "pending-applied"])(
    "keeps %s UNKNOWN, including an applied debit whose action has not finished",
    async (state) => {
      const saved = receipt(team);
      saved.status = "pending";
      delete saved.result;
      delete saved.completed_at;
      if (state === "pending-empty") saved.debits = [];
      mockQuery.mockResolvedValue(state === "missing" ? null : saved);
      await expect(deduct(team)).resolves.toEqual(unknown);
      expect(mockAction).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockMutation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["operation_id", "another-operation"],
    ["user_id", "another-user"],
    ["organization_id", "another-org"],
    ["usage_settlement_id", "another-settlement"],
    ["amount_points", 21],
  ])("rejects a mismatched %s fingerprint", async (key, value) => {
    mockQuery.mockResolvedValue({ ...receipt(team), [key]: value });
    await expect(deduct(team)).resolves.toEqual(unknown);
    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it("recovers a completed denial without claiming a debit", async () => {
    const saved = receipt(team);
    saved.debits = [];
    saved.result = {
      ...saved.result!,
      success: false,
      monthlyCapExceeded: true,
    };
    mockQuery.mockResolvedValue(saved);
    await expect(deduct(team)).resolves.toEqual(saved.result);
    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(mockMutation).not.toHaveBeenCalled();
  });
});

it.each([
  "no-applied-receipt",
  "wrong-delta",
  "duplicate-applied",
  "denied-but-applied",
  "null-before",
  "null-after",
  "debit-not-successful",
  "missing-result",
  "pending-with-result",
])(
  "does not clear UNKNOWN for an inconsistent completed action: %s",
  async (state) => {
    const saved = receipt(false);
    if (state === "no-applied-receipt") saved.debits = [];
    if (state === "wrong-delta") saved.debits[0].new_balance_points = 79;
    if (state === "duplicate-applied")
      saved.debits.push({ ...saved.debits[0], sequence: 1 });
    if (state === "denied-but-applied") saved.result!.success = false;
    if (state === "null-before") saved.debits[0].previous_balance_points = null;
    if (state === "null-after") saved.debits[0].new_balance_points = null;
    if (state === "debit-not-successful")
      saved.debits[0].result.success = false;
    if (state === "missing-result") delete saved.result;
    if (state === "pending-with-result") saved.status = "pending";
    mockQuery.mockResolvedValue(saved);
    await expect(deduct(false)).resolves.toEqual(unknown);
    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(mockMutation).not.toHaveBeenCalled();
  },
);

it("returns the completed reload result without driving a second reload", async () => {
  const saved = receipt(false);
  saved.auto_reload_operation_ids = ["synthetic-reload"];
  saved.result = {
    ...saved.result!,
    autoReloadTriggered: true,
    autoReloadResult: { success: true, chargedAmountDollars: 20 },
  };
  mockQuery.mockResolvedValue(saved);
  await expect(deduct(false)).resolves.toEqual(saved.result);
  expect(mockAction).toHaveBeenCalledTimes(1);
  expect(mockMutation).not.toHaveBeenCalled();
});

it("retains UNKNOWN if the read fails, without retrying either RPC", async () => {
  mockQuery.mockRejectedValue(new TypeError("fetch failed"));
  await expect(deduct(false)).resolves.toEqual(unknown);
  expect(mockAction).toHaveBeenCalledTimes(1);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockMutation).not.toHaveBeenCalled();
});

it("bounds an unresponsive read, aborts its scoped client and ignores a late result", async () => {
  jest.useFakeTimers();
  let resolve!: (value: Receipt) => void;
  mockQuery.mockImplementation(
    () =>
      new Promise<Receipt>((done) => {
        resolve = done;
      }),
  );
  const pending = deduct(false);
  await jest.advanceTimersByTimeAsync(1500);
  await expect(pending).resolves.toEqual(unknown);
  expect(readSignals).toHaveLength(1);
  expect(readSignals[0].aborted).toBe(true);
  resolve(receipt(false));
  await Promise.resolve();
  expect(mockAction).toHaveBeenCalledTimes(1);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockMutation).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it("does not query receipts when the action returns normally", async () => {
  mockAction.mockResolvedValue(result);
  await expect(deduct(false)).resolves.toEqual(result);
  expect(mockQuery).not.toHaveBeenCalled();
});
