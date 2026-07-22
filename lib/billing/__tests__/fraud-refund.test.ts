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
    expect(
      isRefundAmountRaceError({
        statusCode: 400,
        type: "StripeInvalidRequestError",
        rawType: "invalid_request_error",
        code: undefined,
        param: "amount",
        message:
          "Refund amount ($25.00) is greater than unrefunded amount on charge ($0.21)",
        raw: {
          type: "invalid_request_error",
          code: undefined,
          param: "amount",
          message:
            "Refund amount ($25.00) is greater than unrefunded amount on charge ($0.21)",
        },
      }),
    ).toBe(true);
    expect(
      isRefundAmountRaceError({
        statusCode: 400,
        type: "StripeInvalidRequestError",
        rawType: "invalid_request_error",
        code: undefined,
        param: "amount",
        message: "Amount must be at least 1 cent",
      }),
    ).toBe(false);
    expect(
      isRefundAmountRaceError({
        statusCode: 400,
        type: "StripeInvalidRequestError",
        rawType: "invalid_request_error",
        code: "resource_missing",
        param: "amount",
        message:
          "Refund amount ($25.00) is greater than unrefunded amount on charge ($0.21)",
      }),
    ).toBe(false);
  });

  it("refreshes the charge and bounds one idempotent race retry", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const raceError = {
      statusCode: 400,
      type: "StripeInvalidRequestError",
      rawType: "invalid_request_error",
      code: undefined,
      param: "amount",
      message:
        "Refund amount ($25.00) is greater than unrefunded amount on charge ($0.03)",
      raw: {
        type: "invalid_request_error",
        code: undefined,
        param: "amount",
        message:
          "Refund amount ($25.00) is greater than unrefunded amount on charge ($0.03)",
      },
    };
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
    expect(create).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[1],
    );
  });

  it("does not retry again when the bounded race retry also fails", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const raceError = {
      statusCode: 400,
      type: "StripeInvalidRequestError",
      rawType: "invalid_request_error",
      code: undefined,
      param: "amount",
      message:
        "Refund amount ($25.00) is greater than unrefunded amount on charge ($0.03)",
    };
    const create = jest.fn().mockRejectedValue(raceError);
    const retrieve = jest.fn().mockResolvedValue({
      id: "ch_123",
      amount: 2_500,
      amount_refunded: 2_497,
    } as Stripe.Charge);

    await expect(
      refundChargeForEFW(
        { charges: { retrieve }, refunds: { create } },
        {
          id: "ch_123",
          amount: 2_500,
          amount_refunded: 0,
        } as Stripe.Charge,
        "issfr_123",
      ),
    ).rejects.toBe(raceError);

    expect(create).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("treats Stripe's non-refundable charge error as terminal", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const create = jest
      .fn<
        (
          params: { amount: number; charge: string; reason: "fraudulent" },
          options: { idempotencyKey: string },
        ) => Promise<unknown>
      >()
      .mockRejectedValue({
        statusCode: 400,
        code: "charge_not_refundable",
      });
    const retrieve = jest.fn<(chargeId: string) => Promise<Stripe.Charge>>();

    await expect(
      refundChargeForEFW(
        { charges: { retrieve }, refunds: { create } },
        {
          id: "ch_123",
          amount: 2_500,
          amount_refunded: 0,
        } as Stripe.Charge,
        "issfr_123",
      ),
    ).resolves.toBeUndefined();

    expect(retrieve).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
