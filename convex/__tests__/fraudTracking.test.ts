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
  },
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

const SERVICE_KEY = "test-service-key";
process.env.CONVEX_SERVICE_ROLE_KEY = SERVICE_KEY;

const CUSTOMER_ID = "cus_test_123";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock Convex context with a configurable first() result. */
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

function makeRecord(overrides: Record<string, any> = {}) {
  return {
    _id: "doc_abc" as any,
    stripe_customer_id: CUSTOMER_ID,
    failure_count: 0,
    weighted_score: 0,
    first_failure_at: Date.now(),
    last_failure_at: Date.now(),
    decline_codes: [] as string[],
    distinct_fingerprints: [] as string[],
    auto_blocked: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let recordPaymentFailure: any;
let isCustomerSuspicious: any;

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});

  const mod = await import("../fraudTracking");
  recordPaymentFailure = mod.recordPaymentFailure;
  isCustomerSuspicious = mod.isCustomerSuspicious;
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
        weighted_score: 1, // default weight
        auto_blocked: false,
      }),
    );
  });

  it("applies double weight for incorrect_number", async () => {
    const { ctx, insertFn } = makeCtx(null);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });

    expect(result.shouldBlock).toBe(false);
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
    const existing = makeRecord({
      failure_count: 2,
      weighted_score: 4, // one more incorrect_number (2pts) will push to 6
      first_failure_at: Date.now() - 1000, // within window
      decline_codes: ["incorrect_number", "incorrect_number"],
    });
    const { ctx, patchFn } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("weighted_score");
    expect(patchFn).toHaveBeenCalledWith(
      existing._id,
      expect.objectContaining({ auto_blocked: true }),
    );
  });

  it("uses lower threshold (3) for new accounts", async () => {
    const existing = makeRecord({
      failure_count: 1,
      weighted_score: 2, // one more incorrect_number (2pts) → 4 >= 3
      first_failure_at: Date.now() - 1000,
      decline_codes: ["incorrect_number"],
    });
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
      isNewAccount: true,
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("weighted_score");
  });

  it("does NOT block new account below lower threshold", async () => {
    const existing = makeRecord({
      failure_count: 1,
      weighted_score: 1, // card_declined (1pt) → 2 < 3
      first_failure_at: Date.now() - 1000,
      decline_codes: ["card_declined"],
    });
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
      isNewAccount: true,
    });

    expect(result.shouldBlock).toBe(false);
  });

  it("resets counter when window expires", async () => {
    const existing = makeRecord({
      failure_count: 4,
      weighted_score: 4,
      first_failure_at: Date.now() - 11 * 60 * 1000, // 11 min ago — expired
      decline_codes: ["a", "b", "c", "d"],
    });
    const { ctx, patchFn } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
    });

    expect(result.shouldBlock).toBe(false);
    expect(result.failureCount).toBe(1);
    expect(patchFn).toHaveBeenCalledWith(
      existing._id,
      expect.objectContaining({
        failure_count: 1,
        weighted_score: 1,
        decline_codes: ["card_declined"],
        distinct_fingerprints: [],
      }),
    );
  });

  it("short-circuits if already blocked", async () => {
    const existing = makeRecord({
      failure_count: 10,
      auto_blocked: true,
    });
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
  // Distinct fingerprints signal
  // ---------------------------------------------------------------------------

  it("blocks when 3 distinct card fingerprints are seen", async () => {
    const existing = makeRecord({
      failure_count: 2,
      weighted_score: 2,
      first_failure_at: Date.now() - 1000,
      decline_codes: ["card_declined", "card_declined"],
      distinct_fingerprints: ["fp_aaa", "fp_bbb"],
    });
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
      cardFingerprint: "fp_ccc", // 3rd unique fingerprint
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("distinct_cards");
  });

  it("does NOT double-count the same fingerprint", async () => {
    const existing = makeRecord({
      failure_count: 1,
      weighted_score: 1,
      first_failure_at: Date.now() - 1000,
      decline_codes: ["card_declined"],
      distinct_fingerprints: ["fp_aaa"],
    });
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
    const existing = makeRecord({
      failure_count: 3,
      weighted_score: 3,
      first_failure_at: Date.now() - 1000,
      decline_codes: [
        "incorrect_number",
        "incorrect_cvc",
        "invalid_expiry_month",
      ],
    });
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined", // 4th distinct code
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.blockReason).toContain("code_diversity");
  });

  it("does NOT block with only 3 distinct decline codes", async () => {
    const existing = makeRecord({
      failure_count: 2,
      weighted_score: 2,
      first_failure_at: Date.now() - 1000,
      decline_codes: ["incorrect_number", "incorrect_cvc"],
    });
    const { ctx } = makeCtx(existing);

    const result = await recordPaymentFailure.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined", // 3rd distinct — below threshold of 4
    });

    expect(result.shouldBlock).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Realistic scenarios
  // ---------------------------------------------------------------------------

  it("handles the screenshot scenario: rapid incorrect_number declines", async () => {
    // Simulate 3 rapid incorrect_number failures (the screenshot pattern)
    // Failure 1: new record, score=2
    const { ctx: ctx1, insertFn } = makeCtx(null);
    const r1 = await recordPaymentFailure.handler(ctx1, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });
    expect(r1.shouldBlock).toBe(false);
    expect(r1.failureCount).toBe(1);

    // Failure 2: score=4, still under threshold
    const after1 = makeRecord({
      failure_count: 1,
      weighted_score: 2,
      first_failure_at: Date.now() - 500,
      decline_codes: ["incorrect_number"],
    });
    const { ctx: ctx2 } = makeCtx(after1);
    const r2 = await recordPaymentFailure.handler(ctx2, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });
    expect(r2.shouldBlock).toBe(false);

    // Failure 3: score=6 >= 5, BLOCKED
    const after2 = makeRecord({
      failure_count: 2,
      weighted_score: 4,
      first_failure_at: Date.now() - 1000,
      decline_codes: ["incorrect_number", "incorrect_number"],
    });
    const { ctx: ctx3 } = makeCtx(after2);
    const r3 = await recordPaymentFailure.handler(ctx3, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "incorrect_number",
    });
    expect(r3.shouldBlock).toBe(true);
    expect(r3.failureCount).toBe(3);
  });

  it("legitimate user: 2 card_declined failures do not trigger block", async () => {
    const { ctx: ctx1 } = makeCtx(null);
    const r1 = await recordPaymentFailure.handler(ctx1, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
      declineCode: "card_declined",
    });
    expect(r1.shouldBlock).toBe(false);

    const after1 = makeRecord({
      failure_count: 1,
      weighted_score: 1,
      first_failure_at: Date.now() - 30_000,
      decline_codes: ["card_declined"],
      distinct_fingerprints: ["fp_aaa"],
    });
    const { ctx: ctx2 } = makeCtx(after1);
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
    const record = makeRecord({ auto_blocked: true });
    const { ctx } = makeCtx(record);

    const result = await isCustomerSuspicious.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
    });

    expect(result).toEqual({ suspicious: true, blocked: true });
  });

  it("returns suspicious when 3+ failures within window", async () => {
    const record = makeRecord({
      failure_count: 3,
      first_failure_at: Date.now() - 1000, // within window
    });
    const { ctx } = makeCtx(record);

    const result = await isCustomerSuspicious.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
    });

    expect(result).toEqual({ suspicious: true, blocked: false });
  });

  it("returns not suspicious when failures are outside window", async () => {
    const record = makeRecord({
      failure_count: 10,
      first_failure_at: Date.now() - 11 * 60 * 1000, // expired
    });
    const { ctx } = makeCtx(record);

    const result = await isCustomerSuspicious.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
    });

    expect(result).toEqual({ suspicious: false, blocked: false });
  });

  it("returns not suspicious when below threshold within window", async () => {
    const record = makeRecord({
      failure_count: 2,
      first_failure_at: Date.now() - 1000,
    });
    const { ctx } = makeCtx(record);

    const result = await isCustomerSuspicious.handler(ctx, {
      serviceKey: SERVICE_KEY,
      stripeCustomerId: CUSTOMER_ID,
    });

    expect(result).toEqual({ suspicious: false, blocked: false });
  });
});
