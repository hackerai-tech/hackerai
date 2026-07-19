import fs from "fs";
import path from "path";
import { describe, expect, it } from "@jest/globals";
import {
  getRemainingRefundAmountCents,
  isRefundAmountRaceError,
} from "../fraud-refund";

const fraudWebhookSource = fs.readFileSync(
  path.resolve(__dirname, "../../../app/api/fraud/webhook/route.ts"),
  "utf8",
);

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
        message:
          "Refund amount ($25.00) is greater than unrefunded amount on charge ($0.03)",
      }),
    ).toBe(true);
    expect(
      isRefundAmountRaceError({
        statusCode: 500,
        message:
          "Refund amount ($25.00) is greater than unrefunded amount on charge ($0.03)",
      }),
    ).toBe(false);
    expect(
      isRefundAmountRaceError({
        statusCode: 400,
        message: "No such charge",
      }),
    ).toBe(false);
  });

  it("refreshes the charge and bounds one idempotent race retry", () => {
    const refreshIndex = fraudWebhookSource.indexOf(
      "stripe.charges.retrieve(charge.id)",
    );
    const boundedRetryIndex = fraudWebhookSource.indexOf(
      "amount: refreshedRemainingAmount",
    );

    expect(refreshIndex).toBeGreaterThan(-1);
    expect(boundedRetryIndex).toBeGreaterThan(refreshIndex);
    expect(fraudWebhookSource).toContain("`efw-refund:${efwId}:remaining`");
  });
});
