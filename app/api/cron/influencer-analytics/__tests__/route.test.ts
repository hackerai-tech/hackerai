jest.mock("next/server", () => ({
  NextResponse: {
    json: (
      body: unknown,
      options: { status?: number; headers?: Record<string, string> } = {},
    ) => ({
      status: options.status ?? 200,
      headers: new Headers(options.headers),
      json: async () => body,
    }),
  },
}));
jest.mock("@/lib/influencers/analytics", () => ({
  flushInfluencerAnalytics: jest.fn(),
}));
import { flushInfluencerAnalytics } from "@/lib/influencers/analytics";
import { GET } from "../route";
const flush = jest.mocked(flushInfluencerAnalytics);
const request = (authorization?: string) =>
  ({
    headers: new Headers(authorization ? { authorization } : {}),
  }) as Request;
describe("influencer analytics retry cron", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.CRON_SECRET = "test-cron";
  });
  it("rejects missing or invalid credentials without touching the queue", async () => {
    for (const value of [undefined, "Bearer wrong", "Bearer test-croo"])
      expect((await GET(request(value))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(request("Bearer test-cron"))).status).toBe(401);
    expect(flush).not.toHaveBeenCalled();
  });
  it("drains at most five batches per invocation", async () => {
    flush.mockResolvedValue({ ok: true, delivered: 100 });
    const response = await GET(request("Bearer test-cron"));
    expect(await response.json()).toEqual({ ok: true, delivered: 500 });
    expect(flush).toHaveBeenCalledTimes(5);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("stops and reports a retryable failure after a partial drain", async () => {
    flush
      .mockResolvedValueOnce({ ok: true, delivered: 100 })
      .mockResolvedValueOnce({ ok: false, delivered: 0 });
    const response = await GET(request("Bearer test-cron"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, delivered: 100 });
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
