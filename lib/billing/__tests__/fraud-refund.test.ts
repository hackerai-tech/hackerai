import { describe, expect, it } from "@jest/globals";
import { getRemainingRefundAmountCents } from "../fraud-refund";

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
});
