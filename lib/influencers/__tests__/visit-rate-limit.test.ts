import { createRedisClient } from "@/lib/rate-limit/redis";
import { allowInfluencerVisitAnalytics } from "../visit-rate-limit";

jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));
const mockEval = jest.fn();
const request = (address?: string) => ({
  headers: new Headers(address ? { "x-vercel-forwarded-for": address } : {}),
});

describe("anonymous influencer analytics admission", () => {
  beforeEach(() => {
    jest.replaceProperty(process, "env", {
      ...process.env,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      WORKOS_COOKIE_PASSWORD: "test-cookie-key",
    });
    jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    mockEval.mockReset().mockResolvedValue(1);
    jest.mocked(createRedisClient).mockReturnValue({ eval: mockEval } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([0, null, undefined, "1", 2])(
    "fails closed on admission response %s",
    async (result) => {
      mockEval.mockResolvedValue(result);
      expect(await allowInfluencerVisitAnalytics(request("192.0.2.1"))).toBe(
        false,
      );
    },
  );

  it("fails closed if Redis or the hashing secret is unavailable", async () => {
    mockEval.mockRejectedValue(new Error("Redis unavailable"));
    expect(await allowInfluencerVisitAnalytics(request())).toBe(false);
    jest.mocked(createRedisClient).mockReturnValue(null);
    expect(await allowInfluencerVisitAnalytics(request())).toBe(false);
    jest.mocked(createRedisClient).mockReturnValue({ eval: mockEval } as never);
    delete process.env.WORKOS_COOKIE_PASSWORD;
    mockEval.mockClear();
    expect(await allowInfluencerVisitAnalytics(request())).toBe(false);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("uses private source keys and one shared global budget despite cookie or address rotation", async () => {
    const first = request("192.0.2.1");
    expect(await allowInfluencerVisitAnalytics(first)).toBe(true);
    first.headers.set("cookie", "hackerai_partner_visitor=rotated");
    first.headers.set("x-forwarded-for", "198.51.100.123");
    await allowInfluencerVisitAnalytics(first);
    await allowInfluencerVisitAnalytics(request("192.0.2.2"));

    const keys = mockEval.mock.calls.map(([, keys]) => keys);
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2][0]).not.toBe(keys[0][0]);
    expect(keys[2][1]).toBe(keys[0][1]);
    expect(JSON.stringify(mockEval.mock.calls)).not.toContain("192.0.2.");
    expect(JSON.stringify(mockEval.mock.calls)).not.toContain(
      "test-cookie-key",
    );
  });

  it("canonicalizes equivalent IPv6 spellings into the same source budget", async () => {
    await allowInfluencerVisitAnalytics(request("2001:db8::1"));
    await allowInfluencerVisitAnalytics(
      request("2001:0DB8:0000:0000:0000:0000:0000:0001"),
    );
    expect(mockEval.mock.calls[0][1]).toEqual(mockEval.mock.calls[1][1]);
  });

  it("shares an unknown budget for invalid or untrusted forwarding headers", async () => {
    await allowInfluencerVisitAnalytics(request());
    await allowInfluencerVisitAnalytics(request("192.0.2.1, 192.0.2.2"));
    delete process.env.VERCEL;
    await allowInfluencerVisitAnalytics(request("192.0.2.1"));
    await allowInfluencerVisitAnalytics(request("192.0.2.2"));
    const keys = mockEval.mock.calls.map(([, keys]) => keys);
    expect(keys.every((entry) => entry[0] === keys[0][0])).toBe(true);
  });

  it("rotates identifiers each minute and separates Preview from Production", async () => {
    await allowInfluencerVisitAnalytics(request("192.0.2.1"));
    jest.mocked(Date.now).mockReturnValue(1_800_000_060_000);
    await allowInfluencerVisitAnalytics(request("192.0.2.1"));
    process.env.VERCEL_ENV = "production";
    await allowInfluencerVisitAnalytics(request("192.0.2.1"));
    const keys = mockEval.mock.calls.map(([, keys]) => keys);
    expect(new Set(keys.map(([source]) => source)).size).toBe(3);
    expect(new Set(keys.map(([, global]) => global)).size).toBe(3);
  });
});
