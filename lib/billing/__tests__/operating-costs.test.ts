import {
  allocateBillingPeriods,
  normalizeUpstashCosts,
  type BillingPeriod,
  prepareOperatingImport,
} from "../operating-costs";

const period: BillingPeriod = {
  start: "2026-10-01",
  end: "2026-11-01",
  currency: "USD",
  totalDollars: 100,
  reference: "invoice-1",
  status: "billed",
};

test("invoice daily allocations preserve the exact total, cents and source period", () => {
  const rows = allocateBillingPeriods(
    [period],
    "2026-10-01",
    "2026-10-31",
    "billing",
    "identity",
  );
  expect(rows).toHaveLength(31);
  expect(
    rows.reduce((n, row) => n + Math.round(row.billedCostDollars! * 100), 0),
  ).toBe(10000);
  expect(
    rows.every(
      (row) =>
        row.costBasis === "billing_period_allocation" &&
        row.billingReference === "invoice-1" &&
        row.sourcePeriodEnd === "2026-11-01T00:00:00.000Z",
    ),
  ).toBe(true);
});

test("an issued invoice replaces the matching forecast without double counting", () => {
  const estimate: BillingPeriod = {
    ...period,
    totalDollars: 120,
    reference: "forecast",
    status: "estimated",
  };
  for (const periods of [
    [estimate, period],
    [period, estimate],
  ]) {
    const rows = allocateBillingPeriods(
      periods,
      "2026-10-01",
      "2026-10-31",
      "billing",
      "identity",
    );
    expect(
      rows.reduce((n, row) => n + Math.round(row.billedCostDollars! * 100), 0),
    ).toBe(10000);
    expect(rows.every((row) => row.costStatus === "billed")).toBe(true);
  }
});

test("missing and overlapping periods cannot replace a known billing window", () => {
  expect(() =>
    allocateBillingPeriods(
      [period],
      "2026-09-30",
      "2026-10-31",
      "billing",
      "identity",
    ),
  ).toThrow("missing days");
  expect(() =>
    allocateBillingPeriods(
      [period, { ...period, start: "2026-10-15", end: "2026-11-15" }],
      "2026-10-01",
      "2026-10-31",
      "billing",
      "identity",
    ),
  ).toThrow("Overlapping");
  expect(() =>
    allocateBillingPeriods(
      [period, period],
      "2026-10-01",
      "2026-10-31",
      "billing",
      "identity",
    ),
  ).toThrow("Duplicate");
});

test("credits retain their sign and only the requested days are returned", () => {
  const rows = allocateBillingPeriods(
    [{ ...period, totalDollars: -0.31 }],
    "2026-10-10",
    "2026-10-11",
    "billing",
    "identity",
  );
  expect(rows.map((row) => row.billedCostDollars)).toEqual([-0.01, -0.01]);
});

test.each([NaN, Infinity, undefined, 1.001])(
  "unrepresentable invoice totals are rejected: %s",
  (amount) => {
    expect(() =>
      allocateBillingPeriods(
        [{ ...period, totalDollars: amount as number }],
        "2026-10-01",
        "2026-10-31",
        "billing",
        "identity",
      ),
    ).toThrow();
  },
);

test("Redis consumes provider dollar amounts once, including an existing fixed fee", () => {
  const rows = normalizeUpstashCosts(
    [
      {
        databaseId: "prod",
        dailyBilling: [
          { x: "2026-11-11 19:50:17.33405622 +0000 UTC", y: 0.333 },
          { x: "2026-11-12 19:50:17.33405622 +0000 UTC", y: 0.111 },
        ],
      },
    ],
    ["prod"],
    "2026-11-11",
    "2026-11-11",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].effectiveCostDollars).toBe(0.333);
  expect(rows[0].costBasis).toBe("provider_daily_spend");
});

test("partial resource coverage, missing dates and non-UTC stats fail closed", () => {
  const observation = {
    databaseId: "prod",
    dailyBilling: [{ x: "2026-11-11 19:50:17.1 +0000 UTC", y: 0.333 }],
  };
  expect(() =>
    normalizeUpstashCosts(
      [observation],
      ["prod", "dev"],
      "2026-11-11",
      "2026-11-11",
    ),
  ).toThrow("resource scope");
  expect(() =>
    normalizeUpstashCosts([observation], ["prod"], "2026-11-10", "2026-11-11"),
  ).toThrow("missing days");
  expect(() =>
    normalizeUpstashCosts(
      [
        {
          ...observation,
          dailyBilling: [{ x: "2026-11-11 00:00:00 -0600 CST", y: 0.333 }],
        },
      ],
      ["prod"],
      "2026-11-11",
      "2026-11-11",
    ),
  ).toThrow("not UTC");
});

test("operator snapshots require fresh observations, matching source identity and completed UTC days", () => {
  const now = Date.parse("2026-11-12T19:00:00Z");
  const snapshot = {
    vendor: "workos",
    workosTeamName: "Example",
    observedAt: "2026-11-12T18:00:00Z",
    startDay: "2026-10-01",
    endDay: "2026-10-31",
    billingPeriods: [period],
  };
  expect(
    prepareOperatingImport(snapshot, { workosTeamName: "Example" }, now).rows,
  ).toHaveLength(31);
  expect(() =>
    prepareOperatingImport(snapshot, { workosTeamName: "Other" }, now),
  ).toThrow("workspace");
  expect(() =>
    prepareOperatingImport(
      { ...snapshot, observedAt: "2026-11-01T00:00:00Z" },
      { workosTeamName: "Example" },
      now,
    ),
  ).toThrow("stale");
  expect(() =>
    prepareOperatingImport(
      { ...snapshot, endDay: "2026-11-12" },
      { workosTeamName: "Example" },
      now,
    ),
  ).toThrow("complete UTC days");
});
