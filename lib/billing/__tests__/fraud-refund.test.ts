import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type Stripe from "stripe";
import {
  getRemainingRefundAmountCents,
  isRefundAmountRaceError,
  refundChargeForEFW,
} from "../fraud-refund";

afterEach(() => {
  jest.restoreAllMocks();
});

describe("getRemainingRefundAmountCents", () => {
  it("returns the full charge amount when nothing has been refunded", () => {
    expect(
      getRemainingRefundAmountCents({ amount: 20_000, amount_refunded: 0 }),
    ).toBe(20_000);
  });

  it("returns only the remaining amount after a partial refund", () => {
    expect(
      getRemainingRefundAmountCents({
        amount: 20_000,
        amount_refunded: 19_140,
      }),
    ).toBe(860);
  });

  it("never returns a negative refund amount", () => {
    expect(
      getRemainingRefundAmountCents({ amount: 2_000, amount_refunded: 2_000 }),
    ).toBe(0);
  });

  it("matches only Stripe's refund-balance race response", () => {
    expect(
      isRefundAmountRaceError({
        statusCode: 400,
        code: "amount_too_large",
      }),
    ).toBe(true);
    expect(
      isRefundAmountRaceError({
        statusCode: 500,
        code: "amount_too_large",
      }),
    ).toBe(false);
    expect(
      isRefundAmountRaceError({
        statusCode: 400,
        code: "resource_missing",
      }),
    ).toBe(false);
  });

  it("refreshes the charge and bounds one idempotent race retry", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const raceError = { statusCode: 400, code: "amount_too_large" };
    const create = jest
      .fn<
        (
          params: { amount: number; charge: string; reason: "fraudulent" },
          options: { idempotencyKey: string },
        ) => Promise<unknown>
      >()
      .mockRejectedValueOnce(raceError)
      .mockResolvedValueOnce({ id: "re_123" });
    const retrieve = jest
      .fn<(chargeId: string) => Promise<Stripe.Charge>>()
      .mockResolvedValue({
        id: "ch_123",
        amount: 2_500,
        amount_refunded: 2_497,
      } as Stripe.Charge);

    await refundChargeForEFW(
      { charges: { retrieve }, refunds: { create } },
      {
        id: "ch_123",
        amount: 2_500,
        amount_refunded: 0,
      } as Stripe.Charge,
      "issfr_123",
    );

    expect(create).toHaveBeenNthCalledWith(
      1,
      { amount: 2_500, charge: "ch_123", reason: "fraudulent" },
      { idempotencyKey: "efw-refund:issfr_123:2500" },
    );
    expect(retrieve).toHaveBeenCalledWith("ch_123");
    expect(create).toHaveBeenNthCalledWith(
      2,
      { amount: 3, charge: "ch_123", reason: "fraudulent" },
      { idempotencyKey: "efw-refund:issfr_123:remaining:3" },
    );
    expect(retrieve.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[1],
    );
  });
});
