import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));
jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    array: jest.fn(() => "array"),
    null: jest.fn(() => "null"),
  },
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

const SERVICE_KEY = "test-service-key";
process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;

const CUSTOMER_ID = "cus_test_123";
const WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(existingRecord: Record<string, any> | null = null) {
  const patchFn = jest.fn<any>();
  const insertFn = jest.fn<any>();

  const ctx = {
    db: {
      query: jest.fn().mockReturnValue({
        withIndex: jest.fn().mockReturnValue({
          first: jest.fn<any>().mockResolvedValue(existingRecord),
        }),
      }),
      patch: patchFn,
      insert: insertFn,
    },
  };

  return { ctx, patchFn, insertFn };
}

/** Build a failure entry for the sliding window. */
function makeEntry(
  overrides: Partial<{
    timestamp: number;
    declineCode: string;
    fingerprint: string | null;
    weight: number;
  }> = {},
) {
  return {
    timestamp: Date.now(),
    declineCode: "card_declined",
    fingerprint: null,
    weight: 1,
    ...overrides,
  };
}

/** Build a tracking record with entries serialized. */
function makeRecord(overrides: Record<string, any> = {}, entries: any[] = []) {
  return {
    _id: "doc_abc" as any,
    stripe_customer_id: CUSTOMER_ID,
    failure_count: entries.length,
    weighted_score: entries.reduce(
      (sum: number, e: any) => sum + (e.weight ?? 1),
      0,
    ),
    first_failure_at: entries.length > 0 ? entries[0].timestamp : Date.now(),
    last_failure_at:
      entries.length > 0 ? entries[entries.length - 1].timestamp : Date.now(),
    decline_codes: entries.map((e: any) => e.declineCode ?? "card_declined"),
    distinct_fingerprints: [
      ...new Set(
        entries.map((e: any) => e.fingerprint).filter(Boolean) as string[],
      ),
    ],
    auto_blocked: false,
    entries: JSON.stringify(entries),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let recordPaymentFailure: any;
let isCustomerSuspicious: any;
let markCustomerAutoBlocked: any;

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});

  const mod = await import("../fraudTracking");
  recordPaymentFailure = mod.recordPaymentFailure;
  isCustomerSuspicious = mod.isCustomerSuspicious;
  markCustomerAutoBlocked = mod.markCustomerAutoBlocked;
});

describe("recordPaymentFailure", () => {
  it("creates a new tracking record on first failure", async () => {
    const { ctx, insertFn } = makeCtx(null);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
    });

    expect(result.shouldBlock).toBe(false);
    expect(result.failureCount).toBe(1);
    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(insertFn).toHaveBeenCalledWith(
      "payment_failure_tracking",
      expect.objectContaining({
        stripe_customer_id: CUSTOMER_ID,
        failure_count: 1,
        weighted_score: 1,
        auto_blocked: false,
      }),
    );
  });

  it("applies double weight for incorrect_number", async () => {
    const { ctx, insertFn } = makeCtx(null);

    await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });

    expect(insertFn).toHaveBeenCalledWith(
      "payment_failure_tracking",
      expect.objectContaining({ weighted_score: 2 }),
    );
  });

  it("applies 1.5x weight for incorrect_cvc", async () => {
    const { ctx, insertFn } = makeCtx(null);

    await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_cvc",
    });

    expect(insertFn).toHaveBeenCalledWith(
      "payment_failure_tracking",
      expect.objectContaining({ weighted_score: 1.5 }),
    );
  });

  it("blocks when weighted score reaches threshold (5)", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({
        timestamp: now - 2000,
        declineCode: "incorrect_number",
        weight: 2,
      }),
      makeEntry({
        timestamp: now - 1000,
        declineCode: "incorrect_number",
        weight: 2,
      }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx, patchFn } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number", // +2 → total 6 >= 5
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("weighted_score");
    expect(patchFn).toHaveBeenCalledWith(
      existing._id,
      expect.objectContaining({ auto_blocked: true }),
    );
  });

  it("uses lower threshold (3) for new accounts", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({
        timestamp: now - 1000,
        declineCode: "incorrect_number",
        weight: 2,
      }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number", // +2 → total 4 >= 3
      isNewAccount: true,
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("weighted_score");
  });

  it("does NOT block new account below lower threshold", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({
        timestamp: now - 1000,
        declineCode: "card_declined",
        weight: 1,
      }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined", // +1 → total 2 < 3
      isNewAccount: true,
    });

    expect(result.shouldBlock).toBe(false);
  });

  it("short-circuits if already blocked", async () => {
    const existing = makeRecord({ auto_blocked: true, failure_count: 10 }, []);
    const { ctx, patchFn, insertFn } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toBe("already_blocked");
    expect(patchFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // True sliding window
  // ---------------------------------------------------------------------------

  it("prunes old entries outside the window (true sliding window)", async () => {
    const now = Date.now();
    const entries = [
      // These are OUTSIDE the window — should be pruned
      makeEntry({
        timestamp: now - WINDOW_MS - 5000,
        declineCode: "incorrect_number",
        weight: 2,
      }),
      makeEntry({
        timestamp: now - WINDOW_MS - 4000,
        declineCode: "incorrect_number",
        weight: 2,
      }),
      makeEntry({
        timestamp: now - WINDOW_MS - 3000,
        declineCode: "incorrect_number",
        weight: 2,
      }),
      makeEntry({
        timestamp: now - WINDOW_MS - 2000,
        declineCode: "incorrect_number",
        weight: 2,
      }),
      // This one is INSIDE the window — should be kept
      makeEntry({
        timestamp: now - 1000,
        declineCode: "card_declined",
        weight: 1,
      }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined", // +1 → only 2 in window
    });

    // Old entries pruned; only 2 remain in window (score=2, not 10)
    expect(result.shouldBlock).toBe(false);
    expect(result.failureCount).toBe(2);
  });

  it("does not evade detection by pacing across old-style window boundary", async () => {
    // Regression: old tumbling window would reset at boundary.
    // True sliding window keeps recent entries.
    const now = Date.now();
    const entries = [
      // 4 failures starting 9.5 min ago — all still within 10-min window
      makeEntry({
        timestamp: now - 9.5 * 60 * 1000,
        declineCode: "card_declined",
        weight: 1,
      }),
      makeEntry({
        timestamp: now - 8 * 60 * 1000,
        declineCode: "card_declined",
        weight: 1,
      }),
      makeEntry({
        timestamp: now - 6 * 60 * 1000,
        declineCode: "card_declined",
        weight: 1,
      }),
      makeEntry({
        timestamp: now - 3 * 60 * 1000,
        declineCode: "card_declined",
        weight: 1,
      }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined", // +1 → 5 in window, = threshold
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.failureCount).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // Distinct fingerprints signal
  // ---------------------------------------------------------------------------

  it("blocks when 3 distinct card fingerprints are seen", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({ timestamp: now - 2000, fingerprint: "fp_aaa", weight: 1 }),
      makeEntry({ timestamp: now - 1000, fingerprint: "fp_bbb", weight: 1 }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
      cardFingerprint: "fp_ccc", // 3rd unique
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("distinct_cards");
  });

  it("does NOT double-count the same fingerprint", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({ timestamp: now - 1000, fingerprint: "fp_aaa", weight: 1 }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx, patchFn } = makeCtx(existing);

    await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
      cardFingerprint: "fp_aaa", // same fingerprint
    });

    expect(patchFn).toHaveBeenCalledWith(
      existing._id,
      expect.objectContaining({
        distinct_fingerprints: ["fp_aaa"], // not duplicated
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Decline code diversity signal
  // ---------------------------------------------------------------------------

  it("blocks when 4 distinct decline codes are seen", async () => {
    const now = Date.now();
    // Use low-weight codes so weighted score stays below 5 and
    // the diversity signal is what triggers the block
    const entries = [
      makeEntry({ timestamp: now - 3000, declineCode: "code_a", weight: 1 }),
      makeEntry({ timestamp: now - 2000, declineCode: "code_b", weight: 1 }),
      makeEntry({ timestamp: now - 1000, declineCode: "code_c", weight: 1 }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "code_d", // 4th distinct code, total score = 4 < 5
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("code_diversity");
  });

  it("does NOT block with only 3 distinct decline codes", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({
        timestamp: now - 2000,
        declineCode: "incorrect_number",
        weight: 2,
      }),
      makeEntry({
        timestamp: now - 1000,
        declineCode: "incorrect_cvc",
        weight: 1.5,
      }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined", // 3rd distinct — below threshold of 4
    });

    // Score is 2 + 1.5 + 1 = 4.5 which is < 5, and only 3 distinct codes
    expect(result.shouldBlock).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Realistic scenarios
  // ---------------------------------------------------------------------------

  it("handles the screenshot scenario: rapid incorrect_number declines", async () => {
    // Failure 1: new record, score=2
    const { ctx: ctx1 } = makeCtx(null);
    const r1 = await recordPaymentFailure.handler(ctx1, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });
    expect(r1.shouldBlock).toBe(false);
    expect(r1.failureCount).toBe(1);

    // Failure 2: score=4, still under threshold
    const now = Date.now();
    const entries2 = [
      makeEntry({
        timestamp: now - 500,
        declineCode: "incorrect_number",
        weight: 2,
      }),
    ];
    const { ctx: ctx2 } = makeCtx(makeRecord({}, entries2));
    const r2 = await recordPaymentFailure.handler(ctx2, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });
    expect(r2.shouldBlock).toBe(false);

    // Failure 3: score=6 >= 5, BLOCKED
    const entries3 = [
      makeEntry({
        timestamp: now - 1000,
        declineCode: "incorrect_number",
        weight: 2,
      }),
      makeEntry({
        timestamp: now - 500,
        declineCode: "incorrect_number",
        weight: 2,
      }),
    ];
    const { ctx: ctx3 } = makeCtx(makeRecord({}, entries3));
    const r3 = await recordPaymentFailure.handler(ctx3, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });
    expect(r3.shouldBlock).toBe(true);
    expect(r3.failureCount).toBe(3);
  });

  it("does NOT stack weight from repeated retries of the same card", async () => {
    // Legit user hitting do_not_honor on the same card 4x — with fingerprint
    // dedup, weighted score = max(weight) = 2, not 8. Does not block even
    // on the new-account lower threshold of 3.
    const now = Date.now();
    const entries = [
      makeEntry({
        timestamp: now - 4000,
        declineCode: "incorrect_number",
        fingerprint: "fp_same",
        weight: 2,
      }),
      makeEntry({
        timestamp: now - 3000,
        declineCode: "incorrect_number",
        fingerprint: "fp_same",
        weight: 2,
      }),
      makeEntry({
        timestamp: now - 2000,
        declineCode: "incorrect_number",
        fingerprint: "fp_same",
        weight: 2,
      }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
      cardFingerprint: "fp_same",
      isNewAccount: true,
    });

    expect(result.shouldBlock).toBe(false);
  });

  it("still blocks on distinct-fingerprint test across cards", async () => {
    // Card-tester using 3 different cards — fingerprint dedup shouldn't save
    // them; Signal 2 (distinct_cards) fires at 3 fingerprints.
    const now = Date.now();
    const entries = [
      makeEntry({ timestamp: now - 2000, fingerprint: "fp_a", weight: 1 }),
      makeEntry({ timestamp: now - 1000, fingerprint: "fp_b", weight: 1 }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
      cardFingerprint: "fp_c",
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("distinct_cards");
  });

  it("null-fingerprint entries still count individually in weighted score", async () => {
    // Can't bypass detection by stripping fingerprint data.
    const now = Date.now();
    const entries = [
      makeEntry({
        timestamp: now - 2000,
        declineCode: "incorrect_number",
        fingerprint: null,
        weight: 2,
      }),
      makeEntry({
        timestamp: now - 1000,
        declineCode: "incorrect_number",
        fingerprint: null,
        weight: 2,
      }),
    ];
    const existing = makeRecord({}, entries);
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number", // 2 + 2 + 2 = 6 >= 5
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("weighted_score");
  });

  it("legitimate user: 2 card_declined failures do not trigger block", async () => {
    const { ctx: ctx1 } = makeCtx(null);
    const r1 = await recordPaymentFailure.handler(ctx1, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
    });
    expect(r1.shouldBlock).toBe(false);

    const now = Date.now();
    const entries = [
      makeEntry({
        timestamp: now - 30_000,
        declineCode: "card_declined",
        fingerprint: "fp_aaa",
        weight: 1,
      }),
    ];
    const { ctx: ctx2 } = makeCtx(makeRecord({}, entries));
    const r2 = await recordPaymentFailure.handler(ctx2, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
      cardFingerprint: "fp_aaa", // same card retried
    });
    expect(r2.shouldBlock).toBe(false);
    expect(r2.failureCount).toBe(2);
  });
});

describe("markCustomerAutoBlocked", () => {
  it("creates a blocked record when no record exists", async () => {
    const { ctx, insertFn } = makeCtx(null);

    await markCustomerAutoBlocked.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      reason: "immediate_block:stolen_card",
    });

    expect(insertFn).toHaveBeenCalledWith(
      "payment_failure_tracking",
      expect.objectContaining({
        stripe_customer_id: CUSTOMER_ID,
        auto_blocked: true,
      }),
    );
  });

  it("patches existing record to blocked", async () => {
    const existing = makeRecord({}, []);
    const { ctx, patchFn } = makeCtx(existing);

    await markCustomerAutoBlocked.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      reason: "immediate_block:fraudulent",
    });

    expect(patchFn).toHaveBeenCalledWith(
      existing._id,
      expect.objectContaining({ auto_blocked: true }),
    );
  });
});

describe("isCustomerSuspicious", () => {
  it("returns not suspicious when no record exists", async () => {
    const { ctx } = makeCtx(null);

    const result = await isCustomerSuspicious.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
    });

    expect(result).toEqual({ suspicious: false, blocked: false });
  });

  it("returns blocked when auto_blocked is true", async () => {
    const record = makeRecord({ auto_blocked: true }, []);
    const { ctx } = makeCtx(record);

    const result = await isCustomerSuspicious.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
    });

    expect(result).toEqual({ suspicious: true, blocked: true });
  });

  it("returns suspicious when 3+ failures within sliding window", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({ timestamp: now - 3000 }),
      makeEntry({ timestamp: now - 2000 }),
      makeEntry({ timestamp: now - 1000 }),
    ];
    const record = makeRecord({}, entries);
    const { ctx } = makeCtx(record);

    const result = await isCustomerSuspicious.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
    });

    expect(result).toEqual({ suspicious: true, blocked: false });
  });

  it("returns not suspicious when failures are outside sliding window", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({ timestamp: now - WINDOW_MS - 5000 }),
      makeEntry({ timestamp: now - WINDOW_MS - 4000 }),
      makeEntry({ timestamp: now - WINDOW_MS - 3000 }),
      makeEntry({ timestamp: now - WINDOW_MS - 2000 }),
    ];
    // failure_count is high but all entries are outside the window
    const record = makeRecord({}, entries);
    const { ctx } = makeCtx(record);

    const result = await isCustomerSuspicious.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
    });

    expect(result).toEqual({ suspicious: false, blocked: false });
  });

  it("returns not suspicious when below threshold within window", async () => {
    const now = Date.now();
    const entries = [
      makeEntry({ timestamp: now - 2000 }),
      makeEntry({ timestamp: now - 1000 }),
    ];
    const record = makeRecord({}, entries);
    const { ctx } = makeCtx(record);

    const result = await isCustomerSuspicious.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
    });

    expect(result).toEqual({ suspicious: false, blocked: false });
  });
});
