import {
  hac248AssignmentFromMetadata,
  hac248Metadata,
  parseHac248Assignment,
  parseProMonthlyQuote,
  type Hac248Assignment,
} from "@/lib/experiments/pro-monthly-pricing-hac248";

const testAssignment: Hac248Assignment = {
  version: 1,
  key: "hac248-pro-monthly-49-pricing-proposal",
  variant: "test",
  priceLookupKey: "pro-monthly-plan-49-hac248",
  displayedAmountDollars: 49,
  stripePriceId: "price_pro_49",
  assignedAt: "2026-11-20T10:00:00.000Z",
};
const testQuote = {
  priceLookupKey: "pro-monthly-plan-49-hac248",
  displayedAmountDollars: 49,
  currency: "usd",
  billingInterval: "month",
  stripePriceId: "price_pro_49",
};
const controlQuote = {
  priceLookupKey: "pro-monthly-plan",
  displayedAmountDollars: 29,
  currency: "usd",
  billingInterval: "month",
  stripePriceId: "price_pro_29",
};

describe("HAC-248 account price quote", () => {
  it("accepts the current $29 price without an assignment and a $49 quote only with its assignment", () => {
    expect(parseProMonthlyQuote(controlQuote)).toEqual({ price: controlQuote });
    expect(
      parseProMonthlyQuote({ ...testQuote, assignment: testAssignment }),
    ).toEqual({ price: testQuote, assignment: testAssignment });
    expect(parseProMonthlyQuote(testQuote)).toBeUndefined();
  });

  it.each([
    [
      "$49 under the $29 lookup key",
      { ...controlQuote, displayedAmountDollars: 49 },
    ],
    [
      "$29 under the $49 lookup key",
      { ...testQuote, displayedAmountDollars: 29, assignment: testAssignment },
    ],
    [
      "a lower unlisted amount",
      { ...controlQuote, displayedAmountDollars: 19 },
    ],
    ["a different currency", { ...controlQuote, currency: "eur" }],
    ["a yearly interval", { ...controlQuote, billingInterval: "year" }],
    ["a missing Price ID", { ...controlQuote, stripePriceId: "" }],
    [
      "an assignment quoting a different Price",
      {
        ...testQuote,
        assignment: { ...testAssignment, stripePriceId: "price_other" },
      },
    ],
    [
      "an assignment for the other variant",
      {
        ...controlQuote,
        assignment: {
          ...testAssignment,
          variant: "control",
          stripePriceId: "price_pro_29",
        },
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseProMonthlyQuote(value)).toBeUndefined();
  });

  it.each([
    ["an unknown version", { ...testAssignment, version: 2 }],
    [
      "another experiment key",
      { ...testAssignment, key: "hac46-pro-monthly-29-pricing" },
    ],
    [
      "an amount that disagrees with its variant",
      { ...testAssignment, displayedAmountDollars: 29 },
    ],
    [
      "a lookup key that disagrees with its variant",
      { ...testAssignment, priceLookupKey: "pro-monthly-plan" },
    ],
    [
      "a non-ISO assignment time",
      { ...testAssignment, assignedAt: "yesterday" },
    ],
  ])("rejects a stored assignment with %s", (_label, value) => {
    expect(parseHac248Assignment(value)).toBeUndefined();
  });
});

describe("HAC-248 subscription metadata", () => {
  it("round-trips the original assignment, independent of the purchased plan", () => {
    const metadata = hac248Metadata(testAssignment) as Record<string, string>;
    expect(hac248AssignmentFromMetadata(metadata)).toEqual(testAssignment);
  });

  it("ignores metadata with a mismatched variant price", () => {
    const metadata = {
      ...(hac248Metadata(testAssignment) as Record<string, string>),
      pricingExperimentPriceLookupKey: "pro-monthly-plan",
    };
    expect(hac248AssignmentFromMetadata(metadata)).toBeUndefined();
  });
});
