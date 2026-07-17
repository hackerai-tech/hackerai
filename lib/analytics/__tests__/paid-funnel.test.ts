import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  PAID_FUNNEL_EVENTS,
  normalizeCheckoutAttemptStartedAt,
} from "../paid-funnel";

const mockRedisSet = jest.fn();
const mockCreateRedisClient = jest.fn(() => ({ set: mockRedisSet }));

jest.mock("server-only", () => ({}));
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: mockCreateRedisClient,
}));

const { claimCheckoutStarted, paidFunnelEventUuid, paidFunnelIdempotencyKey } =
  require("../paid-funnel-server") as typeof import("../paid-funnel-server");

describe("paid funnel attempt identity", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("accepts only a bounded logical-attempt timestamp", () => {
    const startedAt = new Date("2026-07-17T16:30:45.123Z");
    jest.useFakeTimers().setSystemTime(startedAt);

    expect(normalizeCheckoutAttemptStartedAt(startedAt.toISOString())).toEqual(
      startedAt,
    );
    expect(
      normalizeCheckoutAttemptStartedAt(
        startedAt.toISOString(),
        startedAt.getTime() + 86_400_001,
      ),
    ).toBeUndefined();
    expect(
      normalizeCheckoutAttemptStartedAt("not-a-timestamp"),
    ).toBeUndefined();
  });

  it("derives stable UUIDs and Stripe keys per attempt", () => {
    const input = {
      event: PAID_FUNNEL_EVENTS.checkoutStarted,
      userId: "user_123",
      checkoutAttemptId: "ca_attempt_123",
    };

    const eventUuid = paidFunnelEventUuid(input);
    expect(eventUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(paidFunnelEventUuid(input)).toBe(eventUuid);
    expect(
      paidFunnelEventUuid({ ...input, checkoutAttemptId: "ca_attempt_456" }),
    ).not.toBe(eventUuid);

    const key = paidFunnelIdempotencyKey({
      operation: "checkout_session_create",
      scopeId: "cus_123",
      checkoutAttemptId: input.checkoutAttemptId,
    });
    expect(
      paidFunnelIdempotencyKey({
        operation: "checkout_session_create",
        scopeId: "cus_123",
        checkoutAttemptId: input.checkoutAttemptId,
      }),
    ).toBe(key);
    expect(key).toMatch(/^checkout_session_create:[0-9a-f]{32}$/);
  });

  it("claims an attempt once and fails open when Redis is unavailable", async () => {
    mockRedisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await expect(
      claimCheckoutStarted({
        userId: "user_123",
        checkoutAttemptId: "ca_attempt_123",
      }),
    ).resolves.toBe(true);
    await expect(
      claimCheckoutStarted({
        userId: "user_123",
        checkoutAttemptId: "ca_attempt_123",
      }),
    ).resolves.toBe(false);

    expect(mockRedisSet).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^paid_funnel:checkout_started:/),
      1,
      { nx: true, ex: 2_592_000 },
    );

    mockRedisSet.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(
      claimCheckoutStarted({
        userId: "user_123",
        checkoutAttemptId: "ca_attempt_456",
      }),
    ).resolves.toBe(true);

    mockCreateRedisClient.mockReturnValueOnce(null as never);
    await expect(
      claimCheckoutStarted({
        userId: "user_123",
        checkoutAttemptId: "ca_attempt_789",
      }),
    ).resolves.toBe(true);
  });
});
