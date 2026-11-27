import {
  completedUtcDayWindow,
  completedVercelBillingDayWindow,
  convexUsageBaseUrl,
  filterRowsToDayWindow,
  mapConvexUsageToRows,
  parseConvexDeploymentUsage,
  parseVercelFocusStream,
  selectVercelReplacement,
  type PlatformCostRow,
} from "../platform-costs";

function jsonlStream(lines: unknown[], splitAt?: number) {
  const encoded = new TextEncoder().encode(
    lines.map((line) => JSON.stringify(line)).join("\n"),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitAt) {
        controller.enqueue(encoded.slice(0, splitAt));
        controller.enqueue(encoded.slice(splitAt));
      } else {
        controller.enqueue(encoded);
      }
      controller.close();
    },
  });
}

describe("platform cost normalization", () => {
  it("streams and aggregates Vercel FOCUS charges by daily service identity", async () => {
    const base = {
      BillingCurrency: "USD",
      ChargePeriodStart: "2026-08-30T00:00:00.000Z",
      ChargePeriodEnd: "2026-08-31T00:00:00.000Z",
      ChargeCategory: "Usage",
      ServiceName: "Fluid compute",
      ServiceCategory: "Compute",
      ConsumedUnit: "GB-hours",
    };
    const rows = await parseVercelFocusStream(
      jsonlStream(
        [
          {
            ...base,
            BilledCost: 12.25,
            EffectiveCost: 11.5,
            ConsumedQuantity: 100,
          },
          {
            ...base,
            BilledCost: "2.75",
            EffectiveCost: 2.5,
            ConsumedQuantity: 20,
          },
          {
            ...base,
            ServiceName: "Credit",
            ServiceCategory: undefined,
            ChargeCategory: "Credit",
            ConsumedUnit: undefined,
            ConsumedQuantity: undefined,
            BilledCost: -3,
            EffectiveCost: -3,
          },
        ],
        19,
      ),
    );

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      day: "2026-08-30",
      serviceName: "Fluid compute",
      chargeCategory: "Usage",
      costStatus: "billed",
      billedCostDollars: 15,
      effectiveCostDollars: 14,
      usageQuantity: 120,
      usageUnit: "GB-hours",
      sourceChargeCount: 2,
    });
    expect(rows[0]).toMatchObject({
      serviceName: "Credit",
      serviceCategory: "Credit",
      chargeCategory: "Credit",
      billedCostDollars: -3,
      sourceChargeCount: 1,
    });
  });

  it("rejects malformed Vercel costs instead of silently corrupting profit", async () => {
    await expect(
      parseVercelFocusStream(
        jsonlStream([
          {
            BillingCurrency: "USD",
            ChargePeriodStart: "2026-08-30T00:00:00.000Z",
            ChargePeriodEnd: "2026-08-31T00:00:00.000Z",
            ChargeCategory: "Usage",
            ServiceName: "Fluid compute",
            ServiceCategory: "Compute",
            BilledCost: "not-a-number",
          },
        ]),
      ),
    ).rejects.toThrow("BilledCost must be finite");
  });

  it("excludes Vercel charge periods that only overlap a day window boundary", async () => {
    const base = {
      BillingCurrency: "USD",
      ChargePeriodEnd: "2026-07-29T07:00:00.000Z",
      ChargeCategory: "Usage",
      ServiceName: "Fluid compute",
      ServiceCategory: "Compute",
      BilledCost: 1,
    };
    const rows = await parseVercelFocusStream(
      jsonlStream([
        {
          ...base,
          ChargePeriodStart: "2026-07-28T07:00:00.000Z",
        },
        {
          ...base,
          ChargePeriodStart: "2026-07-29T07:00:00.000Z",
          ChargePeriodEnd: "2026-07-30T07:00:00.000Z",
        },
        {
          ...base,
          ChargePeriodStart: "2026-09-01T07:00:00.000Z",
          ChargePeriodEnd: "2026-09-02T07:00:00.000Z",
        },
        {
          ...base,
          ChargePeriodStart: "2026-09-02T07:00:00.000Z",
          ChargePeriodEnd: "2026-09-03T07:00:00.000Z",
        },
      ]),
    );

    expect(filterRowsToDayWindow(rows, "2026-07-29", "2026-09-01")).toEqual([
      expect.objectContaining({ day: "2026-07-29" }),
      expect.objectContaining({ day: "2026-09-01" }),
    ]);
  });

  it("maps Convex deployment usage to metered rows without fake dollars", () => {
    const usage = parseConvexDeploymentUsage({
      metrics: {
        functionCalls: {
          unit: "calls",
          usage: { current_day: 42, current_month: 420 },
        },
        databaseIoGb: {
          unit: "GB",
          usage: { current_day: 1.25, current_month: 5 },
        },
      },
      seedStatus: "complete",
    });
    const rows = mapConvexUsageToRows(
      usage,
      Date.parse("2026-08-30T18:25:00.000Z"),
    );

    expect(rows).toEqual([
      expect.objectContaining({
        day: "2026-08-30",
        serviceName: "databaseIoGb",
        serviceCategory: "database",
        costStatus: "metered",
        usageQuantity: 1.25,
        usageUnit: "GB",
      }),
      expect.objectContaining({
        day: "2026-08-30",
        serviceName: "functionCalls",
        serviceCategory: "operations",
        costStatus: "metered",
        usageQuantity: 42,
        usageUnit: "calls",
      }),
    ]);
    expect(rows[0]).not.toHaveProperty("billedCostDollars");
  });

  it("keeps the completed UTC reconciliation window for other vendors", () => {
    expect(
      completedUtcDayWindow(Date.parse("2026-09-01T13:45:00.000Z"), 35),
    ).toEqual({
      from: "2026-07-28T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
      startDay: "2026-07-28",
      endDay: "2026-08-31",
    });
  });

  it.each([
    {
      name: "includes the latest billing day at the daily standard-time run",
      now: "2026-11-27T12:17:00.000Z",
      expected: {
        from: "2026-10-23T07:00:00.000Z",
        to: "2026-11-27T08:00:00.000Z",
        startDay: "2026-10-23",
        endDay: "2026-11-26",
      },
    },
    {
      name: "ends at daylight-time midnight on the fall-back day",
      now: "2026-11-01T12:17:00.000Z",
      expected: {
        from: "2026-09-27T07:00:00.000Z",
        to: "2026-11-01T07:00:00.000Z",
        startDay: "2026-09-27",
        endDay: "2026-10-31",
      },
    },
    {
      name: "starts at standard-time midnight across spring-forward",
      now: "2027-03-15T12:17:00.000Z",
      expected: {
        from: "2027-02-08T08:00:00.000Z",
        to: "2027-03-15T07:00:00.000Z",
        startDay: "2027-02-08",
        endDay: "2027-03-14",
      },
    },
    {
      name: "excludes a billing day that has not closed",
      now: "2026-11-27T07:59:59.999Z",
      expected: {
        from: "2026-10-22T07:00:00.000Z",
        to: "2026-11-26T08:00:00.000Z",
        startDay: "2026-10-22",
        endDay: "2026-11-25",
      },
    },
  ])("Vercel billing window $name", ({ now, expected }) => {
    expect(completedVercelBillingDayWindow(Date.parse(now), 35)).toEqual(
      expected,
    );
  });

  it("labels whole Pacific billing days inside the requested window", async () => {
    const window = completedVercelBillingDayWindow(
      Date.parse("2026-11-27T12:17:00.000Z"),
      2,
    );
    const base = {
      BillingCurrency: "USD",
      ChargeCategory: "Usage",
      ServiceName: "Fluid compute",
      ServiceCategory: "Compute",
      BilledCost: 1,
    };
    const rows = await parseVercelFocusStream(
      jsonlStream([
        {
          ...base,
          ChargePeriodStart: "2026-11-24T08:00:00.000Z",
          ChargePeriodEnd: "2026-11-25T08:00:00.000Z",
        },
        {
          ...base,
          ChargePeriodStart: "2026-11-25T08:00:00.000Z",
          ChargePeriodEnd: "2026-11-26T08:00:00.000Z",
        },
        {
          ...base,
          ChargePeriodStart: "2026-11-26T08:00:00.000Z",
          ChargePeriodEnd: "2026-11-27T08:00:00.000Z",
        },
      ]),
    );

    expect(selectVercelReplacement(rows, window)).toEqual({
      rows: [
        expect.objectContaining({ day: "2026-11-25" }),
        expect.objectContaining({ day: "2026-11-26" }),
      ],
      startDay: "2026-11-25",
      endDay: "2026-11-26",
    });
  });

  describe("Vercel replacement bounds", () => {
    const window = { startDay: "2026-10-23", endDay: "2026-11-26" };
    const row = (day: string, billedCostDollars: number): PlatformCostRow => ({
      day,
      serviceName: "Fluid compute",
      serviceCategory: "Compute",
      chargeCategory: "Usage",
      billingCurrency: "USD",
      costStatus: "billed",
      billedCostDollars,
      sourcePeriodStart: `${day}T08:00:00.000Z`,
      sourcePeriodEnd: `${day}T08:00:00.000Z`,
      sourceChargeCount: 1,
    });

    it("keeps unobserved days at either boundary out of the replacement", () => {
      expect(
        selectVercelReplacement(
          [row("2026-11-24", 3), row("2026-11-25", 2)],
          window,
        ),
      ).toMatchObject({ startDay: "2026-11-24", endDay: "2026-11-25" });
    });

    it("rejects a missing day between published days", () => {
      expect(() =>
        selectVercelReplacement(
          [row("2026-11-24", 3), row("2026-11-26", 2)],
          window,
        ),
      ).toThrow("missing days within its range");
    });

    it("replaces a latest day published with only zero-cost charges", () => {
      expect(
        selectVercelReplacement(
          [row("2026-11-25", 2), row("2026-11-26", 0)],
          window,
        ),
      ).toMatchObject({ endDay: "2026-11-26" });
    });

    it("rejects an export with no charges in the window", () => {
      expect(() =>
        selectVercelReplacement([row("2026-10-22", 1)], window),
      ).toThrow("no charges in the reconciliation window");
    });
  });

  it("uses Convex's canonical deployment URL for admin usage requests", () => {
    expect(convexUsageBaseUrl("https://careful-otter-456.convex.cloud")).toBe(
      "https://careful-otter-456.convex.cloud",
    );
    expect(() => convexUsageBaseUrl("https://example.com")).toThrow(
      "canonical https://*.convex.cloud URL",
    );
    expect(() => convexUsageBaseUrl("https://.convex.cloud")).toThrow(
      "canonical https://*.convex.cloud URL",
    );
    expect(() =>
      convexUsageBaseUrl("https://careful-otter-456.convex.cloud:8443"),
    ).toThrow("canonical https://*.convex.cloud URL");
    expect(() =>
      convexUsageBaseUrl("https://nested.careful-otter-456.convex.cloud"),
    ).toThrow("canonical https://*.convex.cloud URL");
    expect(() =>
      convexUsageBaseUrl("https://-careful-otter-456.convex.cloud"),
    ).toThrow("canonical https://*.convex.cloud URL");
  });
});
