import { flushInfluencerAnalytics, influencerEventUuid } from "../analytics";

const row = {
  _id: "queue_1",
  key: "invoice:in_private:1",
  event: "influencer_invoice_paid",
  visitor_id: "00000000-0000-4000-8000-000000000001",
  code: "partner",
  timestamp: 1700000000000,
  properties: { net_revenue_delta_cents: 2500, commission_delta_cents: 375 },
};
describe("durable influencer delivery", () => {
  const originalFetch = global.fetch;
  const query = jest.fn();
  const mutation = jest.fn();
  beforeEach(() => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "test-write-key";
    process.env.CONVEX_SERVICE_ROLE_KEY = "test-service";
    delete process.env.INFLUENCER_ANALYTICS_DISABLED;
    query.mockReset().mockResolvedValue([row]);
    mutation.mockReset().mockResolvedValue(null);
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });
  it("uses stable event UUIDs and original timestamps across retries, with no financial identifiers", async () => {
    const client = { query, mutation } as any;
    await flushInfluencerAnalytics(client);
    await flushInfluencerAnalytics(client);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    const again = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(body.batch[0]).toEqual(again.batch[0]);
    expect(body.batch[0].timestamp).toBe("2023-11-14T22:13:20.000Z");
    expect(body.batch[0].uuid).toBe(influencerEventUuid(row.key));
    expect(JSON.stringify(body)).not.toContain("in_private");
    expect(body.batch[0].properties).toMatchObject({
      influencer_code: "partner",
      $geoip_disable: true,
      $process_person_profile: false,
    });
    expect(mutation).toHaveBeenCalledTimes(2);
  });
  it("never acknowledges a failed capture and retries after an ambiguous acknowledgement", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("network"));
    expect(
      (await flushInfluencerAnalytics({ query, mutation } as any)).ok,
    ).toBe(false);
    expect(mutation).not.toHaveBeenCalled();
    mutation.mockRejectedValueOnce(new Error("database"));
    expect(
      (await flushInfluencerAnalytics({ query, mutation } as any)).ok,
    ).toBe(false);
    expect(
      (await flushInfluencerAnalytics({ query, mutation } as any)).ok,
    ).toBe(true);
  });
  it("drops queued events after consent withdrawal without blocking other deliveries", async () => {
    query.mockResolvedValue([{ ...row, suppressed: true }]);
    expect(
      (await flushInfluencerAnalytics({ query, mutation } as any)).ok,
    ).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalled();
  });
  it("retains data when capture is disabled or not configured", async () => {
    process.env.INFLUENCER_ANALYTICS_DISABLED = "true";
    await flushInfluencerAnalytics({ query, mutation } as any);
    delete process.env.INFLUENCER_ANALYTICS_DISABLED;
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    await flushInfluencerAnalytics({ query, mutation } as any);
    expect(query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
