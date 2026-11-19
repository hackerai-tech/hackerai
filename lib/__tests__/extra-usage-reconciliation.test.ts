import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { deductFromBalance, deductFromTeamBalance } from "../extra-usage";
import { phLogger } from "@/lib/posthog/server";

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
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { error: jest.fn(), info: jest.fn() },
}));

type Receipt = NonNullable<
  FunctionReturnType<typeof api.settlementReceipts.getForBackend>
>;
const operationId = "wallet-v1:00000000-0000-4000-8000-000000000001:step:1";
const operationFingerprint =
  "707584ab11e516e202152bfb85afd637209829a4db7eb8d265a0e3aadaee87c3";
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
/** The exact unknown event: existing v1 fields plus one closed reason. */
function unknownEvent(team: boolean, reason: string) {
  return {
    event: "extra_usage_deduction_reconciliation",
    reconciliation_diagnostic_version: 1,
    scope: team ? "team" : "personal",
    settlement_operation_fingerprint: operationFingerprint,
    reconciliation_outcome: "unknown_noreplay",
    receipt_verification_diagnostic_version: 1,
    receipt_verification_reason: reason,
  };
}
function expectOneReconciliationEvent(fields: Record<string, unknown>) {
  expect(phLogger.info).toHaveBeenCalledTimes(1);
  expect(phLogger.info).toHaveBeenCalledWith(
    "Extra usage deduction reconciliation",
    fields,
  );
}
function expectOneReadWithoutReplay() {
  expect(mockAction).toHaveBeenCalledTimes(1);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockMutation).not.toHaveBeenCalled();
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
    expect(phLogger.error).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledWith(
      "Extra usage deduction reconciliation",
      {
        event: "extra_usage_deduction_reconciliation",
        reconciliation_diagnostic_version: 1,
        scope: team ? "team" : "personal",
        settlement_operation_fingerprint: operationFingerprint,
        reconciliation_outcome: "completed_receipt_verified",
        verified_result_success: true,
        receipt_verification_diagnostic_version: 1,
        receipt_verification_reason: "verified_completed",
      },
    );
  });

  it.each([
    ["missing", "receipt_absent"],
    ["pending-empty", "receipt_not_completed"],
    ["pending-applied", "receipt_not_completed"],
  ])(
    "keeps %s UNKNOWN, including an applied debit whose action has not finished",
    async (state, reason) => {
      const saved = receipt(team);
      saved.status = "pending";
      delete saved.result;
      delete saved.completed_at;
      if (state === "pending-empty") saved.debits = [];
      mockQuery.mockResolvedValue(state === "missing" ? null : saved);
      await expect(deduct(team)).resolves.toEqual(unknown);
      expectOneReadWithoutReplay();
      expectOneReconciliationEvent(unknownEvent(team, reason));
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
    expectOneReadWithoutReplay();
    // Exact fields: neither the mismatched key nor either value is reported.
    expectOneReconciliationEvent(
      unknownEvent(team, "receipt_identity_mismatch"),
    );
  });

  it("reports a malformed returned receipt as a verification error, still UNKNOWN", async () => {
    // Passes every identity/status/result guard, then breaks the existing
    // debit traversal; the existing catch must keep the no-replay fence.
    mockQuery.mockResolvedValue({
      ...receipt(team),
      debits: undefined as unknown as Receipt["debits"],
    });
    await expect(deduct(team)).resolves.toEqual(unknown);
    expectOneReadWithoutReplay();
    expect(phLogger.error).toHaveBeenCalledTimes(1);
    expectOneReconciliationEvent(unknownEvent(team, "verification_error"));
  });

  it("labels the local deadline even when the aborted read rejects first", async () => {
    jest.useFakeTimers();
    // A cancellation-aware transport rejects synchronously inside abort(),
    // so its rejection wins the existing race before the deadline's own.
    mockQuery.mockImplementation(() => {
      const signal = readSignals[readSignals.length - 1];
      return new Promise<Receipt>((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const pending = deduct(team);
    await jest.advanceTimersByTimeAsync(1499);
    expect(phLogger.info).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(unknown);
    expect(readSignals).toHaveLength(1);
    expect(readSignals[0].aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    expectOneReadWithoutReplay();
    expectOneReconciliationEvent(unknownEvent(team, "read_deadline"));
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
    expect(phLogger.info).toHaveBeenCalledWith(
      "Extra usage deduction reconciliation",
      expect.objectContaining({
        reconciliation_outcome: "completed_receipt_verified",
        verified_result_success: false,
        receipt_verification_diagnostic_version: 1,
        receipt_verification_reason: "verified_completed",
      }),
    );
  });
});

it.each([
  ["no-applied-receipt", "applied_debit_count_mismatch"],
  ["wrong-delta", "debit_delta_mismatch"],
  ["duplicate-applied", "applied_debit_count_mismatch"],
  ["denied-but-applied", "denied_result_has_applied_debit"],
  ["null-before", "debit_snapshot_missing"],
  ["null-after", "debit_snapshot_missing"],
  ["debit-not-successful", "debit_result_not_successful"],
  ["missing-result", "receipt_result_missing"],
  ["pending-with-result", "receipt_not_completed"],
])(
  "does not clear UNKNOWN for an inconsistent completed action: %s",
  async (state, reason) => {
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
    expectOneReadWithoutReplay();
    expectOneReconciliationEvent(unknownEvent(false, reason));
  },
);

it.each([
  ["mismatched pending receipt without result", "receipt_identity_mismatch"],
  ["pending receipt without result", "receipt_not_completed"],
  ["completed receipt without result or debits", "receipt_result_missing"],
  ["duplicate debits with a missing snapshot", "applied_debit_count_mismatch"],
  ["missing snapshot and wrong unsuccessful debit", "debit_snapshot_missing"],
  ["wrong delta from an unsuccessful debit", "debit_delta_mismatch"],
])("reports the first existing guard that fails: %s", async (state, reason) => {
  const saved = receipt(false);
  const [debit] = saved.debits;
  if (state === "mismatched pending receipt without result") {
    saved.amount_points = 21;
    saved.status = "pending";
    delete saved.result;
  }
  if (state === "pending receipt without result") {
    saved.status = "pending";
    delete saved.result;
    saved.debits = [];
  }
  if (state === "completed receipt without result or debits") {
    delete saved.result;
    saved.debits = [];
  }
  if (state === "duplicate debits with a missing snapshot") {
    debit.previous_balance_points = null;
    saved.debits.push({ ...debit, sequence: 1 });
  }
  if (state === "missing snapshot and wrong unsuccessful debit") {
    debit.new_balance_points = null;
    debit.result.success = false;
  }
  if (state === "wrong delta from an unsuccessful debit") {
    debit.new_balance_points = 79;
    debit.result.success = false;
  }
  mockQuery.mockResolvedValue(saved);
  await expect(deduct(false)).resolves.toEqual(unknown);
  expectOneReadWithoutReplay();
  expectOneReconciliationEvent(unknownEvent(false, reason));
});

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

it.each([
  [
    "rejected",
    () => mockQuery.mockRejectedValue(new TypeError("fetch failed")),
  ],
  [
    "synchronously thrown",
    () =>
      mockQuery.mockImplementation(() => {
        throw new TypeError("client setup failed");
      }),
  ],
])(
  "retains UNKNOWN if the read is %s, without retrying either RPC",
  async (_, failRead) => {
    failRead();
    await expect(deduct(false)).resolves.toEqual(unknown);
    expectOneReadWithoutReplay();
    // Exact fields: the read error's name and message are not copied.
    expectOneReconciliationEvent(unknownEvent(false, "read_error"));
  },
);

it.each(["resolves", "rejects"])(
  "bounds an unresponsive read, aborts its scoped client and ignores a late read that %s",
  async (late) => {
    jest.useFakeTimers();
    let resolve!: (value: Receipt) => void;
    let reject!: (error: Error) => void;
    mockQuery.mockImplementation(
      () =>
        new Promise<Receipt>((done, fail) => {
          resolve = done;
          reject = fail;
        }),
    );
    const pending = deduct(false);
    await jest.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toEqual(unknown);
    expect(readSignals).toHaveLength(1);
    expect(readSignals[0].aborted).toBe(true);
    expectOneReconciliationEvent(unknownEvent(false, "read_deadline"));
    if (late === "resolves") resolve(receipt(false));
    else reject(new TypeError("fetch failed"));
    await jest.advanceTimersByTimeAsync(0);
    expectOneReadWithoutReplay();
    expect(jest.getTimerCount()).toBe(0);
    // The settled reason is neither revised nor emitted a second time.
    expectOneReconciliationEvent(unknownEvent(false, "read_deadline"));
  },
);

it("does not query receipts when the action returns normally", async () => {
  mockAction.mockResolvedValue(result);
  await expect(deduct(false)).resolves.toEqual(result);
  expect(mockQuery).not.toHaveBeenCalled();
  expect(phLogger.info).not.toHaveBeenCalled();
});

it.each([
  { team: false, verified: false },
  { team: false, verified: true },
  { team: true, verified: false },
  { team: true, verified: true },
])(
  "keeps exact results and RPC counts when telemetry throws (team=$team, verified=$verified)",
  async ({ team, verified }) => {
    const saved = receipt(team);
    mockQuery.mockResolvedValue(verified ? saved : null);
    jest.mocked(phLogger.info).mockImplementation(() => {
      throw new Error("telemetry unavailable");
    });
    await expect(deduct(team)).resolves.toEqual(
      verified ? saved.result : unknown,
    );
    expectOneReadWithoutReplay();
    expect(mockQuery.mock.calls[0][1]).toEqual({
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY,
      operation_id: operationId,
      user_id: userId,
      ...(team && { organization_id: organizationId }),
    });
    // The throwing logger did receive the added reason group.
    expect(phLogger.info).toHaveBeenCalledWith(
      "Extra usage deduction reconciliation",
      expect.objectContaining({
        receipt_verification_diagnostic_version: 1,
        receipt_verification_reason: verified
          ? "verified_completed"
          : "receipt_absent",
      }),
    );
  },
);

it.each([
  "private/customer-content",
  `${operationId}\n`,
  `${operationId}${"9".repeat(100)}`,
])(
  "omits an unsafe operation ID from added diagnostics: %j",
  async (arbitraryId) => {
    await expect(
      deductFromBalance(userId, 20, settlementId, arbitraryId),
    ).resolves.toEqual(unknown);
    expect(mockAction.mock.calls[0][1].settlementOperationId).toBe(arbitraryId);
    expect(mockQuery.mock.calls[0][1].operation_id).toBe(arbitraryId);
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledWith(
      "Extra usage deduction reconciliation",
      {
        event: "extra_usage_deduction_reconciliation",
        reconciliation_diagnostic_version: 1,
        scope: "personal",
        reconciliation_outcome: "unknown_noreplay",
        receipt_verification_diagnostic_version: 1,
        receipt_verification_reason: "receipt_absent",
      },
    );
  },
);

it("fingerprints an opaque final-operation ID for joining its outcome", async () => {
  const finalId = operationId.replace(":step:1", ":final");
  await expect(
    deductFromBalance(userId, 20, settlementId, finalId),
  ).resolves.toEqual(unknown);
  expect(phLogger.info).toHaveBeenCalledWith(
    "Extra usage deduction reconciliation",
    expect.objectContaining({
      settlement_operation_fingerprint:
        "4b34c6526c1a49c3a4c6fbcde08ae30531166a1c3376702b1b619a2cd9e4d60d",
    }),
  );
  expect(mockAction).toHaveBeenCalledTimes(1);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockMutation).not.toHaveBeenCalled();
});

it("never logs sensitive-looking digits even inside a wallet-shaped caller ID", async () => {
  const callerId = operationId.replace(":step:1", ":step:4111111111111111");
  await expect(
    deductFromBalance(userId, 20, settlementId, callerId),
  ).resolves.toEqual(unknown);
  expect(mockAction.mock.calls[0][1].settlementOperationId).toBe(callerId);
  expect(mockQuery.mock.calls[0][1].operation_id).toBe(callerId);
  expect(phLogger.info).toHaveBeenCalledTimes(1);
  const fields = jest.mocked(phLogger.info).mock.calls[0][1];
  expect(fields).toEqual({
    event: "extra_usage_deduction_reconciliation",
    reconciliation_diagnostic_version: 1,
    scope: "personal",
    settlement_operation_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    reconciliation_outcome: "unknown_noreplay",
    receipt_verification_diagnostic_version: 1,
    receipt_verification_reason: "receipt_absent",
  });
  expect(JSON.stringify(fields)).not.toContain("4111111111111111");
  expect(JSON.stringify(fields)).not.toContain(callerId);
  expect(mockAction).toHaveBeenCalledTimes(1);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockMutation).not.toHaveBeenCalled();
});

it.each([
  { team: false, source: "default" },
  { team: true, source: "default" },
  { team: false, source: "admission" },
  { team: true, source: "admission" },
])(
  "correlates $source UUID outcomes without plaintext (team=$team)",
  async ({ team, source }) => {
    const generatedId = "00000000-0000-4000-8000-000000000002";
    const uuid = jest.spyOn(crypto, "randomUUID").mockReturnValue(generatedId);
    try {
      const suppliedId = source === "admission" ? generatedId : undefined;
      await expect(
        team
          ? deductFromTeamBalance(
              organizationId,
              userId,
              20,
              undefined,
              suppliedId,
            )
          : deductFromBalance(userId, 20, undefined, suppliedId),
      ).resolves.toEqual(unknown);
      expect(uuid).toHaveBeenCalledTimes(source === "default" ? 1 : 0);
      expect(mockAction.mock.calls[0][1].settlementOperationId).toBe(
        generatedId,
      );
      expect(mockQuery.mock.calls[0][1].operation_id).toBe(generatedId);
      expect(phLogger.info).toHaveBeenCalledTimes(1);
      expect(phLogger.info).toHaveBeenCalledWith(
        "Extra usage deduction reconciliation",
        {
          event: "extra_usage_deduction_reconciliation",
          reconciliation_diagnostic_version: 1,
          scope: team ? "team" : "personal",
          settlement_operation_fingerprint:
            "e79acd97ac88086665d85a762f43d533a45195b6bac5961a993e6ed362471439",
          reconciliation_outcome: "unknown_noreplay",
          receipt_verification_diagnostic_version: 1,
          receipt_verification_reason: "receipt_absent",
        },
      );
      expect(mockAction).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockMutation).not.toHaveBeenCalled();
    } finally {
      uuid.mockRestore();
    }
  },
);
