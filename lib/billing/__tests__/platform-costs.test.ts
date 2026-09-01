import {
  completedUtcDayWindow,
  convexUsageBaseUrl,
  mapConvexUsageToRows,
  parseConvexDeploymentUsage,
  parseVercelFocusStream,
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

  it("returns a completed UTC reconciliation window", () => {
    expect(
      completedUtcDayWindow(Date.parse("2026-09-01T13:45:00.000Z"), 35),
    ).toEqual({
      from: "2026-07-28T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
      startDay: "2026-07-28",
      endDay: "2026-08-31",
    });
  });

  it("uses Convex's canonical deployment URL for admin usage requests", () => {
    expect(convexUsageBaseUrl("prod:happy-capybara-123|secret-value")).toBe(
      "https://happy-capybara-123.convex.cloud",
    );
    expect(
      convexUsageBaseUrl(
        "project:team:project|secret-value",
        "https://careful-otter-456.convex.cloud",
      ),
    ).toBe("https://careful-otter-456.convex.cloud");
    expect(() =>
      convexUsageBaseUrl("project:team:project|secret-value"),
    ).toThrow("CONVEX_DEPLOYMENT_URL is required");
    expect(() =>
      convexUsageBaseUrl(
        "prod:happy-capybara-123|secret-value",
        "https://example.com",
      ),
    ).toThrow("canonical https://*.convex.cloud URL");
  });
});
