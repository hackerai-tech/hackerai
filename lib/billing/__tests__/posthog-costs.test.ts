import { parsePostHogSpend } from "../posthog-costs";

const response = () => ({
  status: "ok",
  next: null,
  results: [
    {
      id: 0,
      breakdown_type: null,
      breakdown_value: null,
      dates: ["2026-11-05", "2026-11-06"],
      data: [113.42, 0],
    },
  ],
});

test("preserves provider USD and explicit zero as provisional operating cost", () => {
  const rows = parsePostHogSpend(response(), "2026-11-05", "2026-11-06");
  expect(rows).toEqual([
    expect.objectContaining({
      day: "2026-11-05",
      effectiveCostDollars: 113.42,
      costStatus: "estimated",
      billingCurrency: "USD",
    }),
    expect.objectContaining({
      day: "2026-11-06",
      effectiveCostDollars: 0,
      costStatus: "estimated",
    }),
  ]);
  expect(rows.every((row) => row.billedCostDollars === undefined)).toBe(true);
});

test.each(["missing", "duplicate", "nonfinite", "breakdown", "paginated"])(
  "rejects %s data before replacing saved costs",
  (kind) => {
    const value = response();
    if (kind === "missing") {
      value.results[0].dates.pop();
      value.results[0].data.pop();
    }
    if (kind === "duplicate")
      value.results[0].dates[1] = value.results[0].dates[0];
    if (kind === "nonfinite") value.results[0].data[0] = NaN;
    if (kind === "breakdown") value.results.push({ ...value.results[0] });
    if (kind === "paginated") Object.assign(value, { next: "another-page" });
    expect(() =>
      parsePostHogSpend(value, "2026-11-05", "2026-11-06"),
    ).toThrow();
  },
);
