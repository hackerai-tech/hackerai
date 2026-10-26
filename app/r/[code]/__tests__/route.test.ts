import { partnerCookie, readPartnerCookie } from "@/lib/influencers/cookie";
import { INFLUENCER_COOKIE } from "@/lib/influencers/policy";
import { INFLUENCER_VISITOR_COOKIE } from "@/lib/influencers/cookie";
import { after } from "next/server";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { flushInfluencerAnalytics } from "@/lib/influencers/analytics";
const mockQuery = jest.fn();
const mockMutation = jest.fn();
const mockEval = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: jest.fn(),
}));
jest.mock("@/lib/influencers/analytics", () => ({
  flushInfluencerAnalytics: jest.fn(),
}));
jest.mock("next/server", () => ({
  after: jest.fn(),
  NextResponse: class {
    status: number;
    headers: Headers;
    values = new Map<string, string>();
    cookies = {
      set: (name: string, value: string) => this.values.set(name, value),
      get: (name: string) => ({ value: this.values.get(name) }),
    };
    constructor(_body: unknown, options: any = {}) {
      this.status = options.status ?? 200;
      this.headers = new Headers(options.headers);
    }
    static redirect(url: URL, status: number) {
      return new this(null, { status, headers: { location: url.toString() } });
    }
  },
}));
import { GET } from "../route";
const request = (values: Record<string, string> = {}, country = "US") =>
  ({
    url: "https://hackerai.co/r/medusa",
    headers: new Headers({ "x-vercel-ip-country": country }),
    cookies: {
      get: (name: string) =>
        values[name] ? { value: values[name] } : undefined,
    },
  }) as any;
describe("short influencer links", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset().mockResolvedValue({ active: true });
    mockMutation.mockReset().mockResolvedValue(null);
    mockEval.mockReset().mockResolvedValue(1);
    jest.mocked(createRedisClient).mockReturnValue({ eval: mockEval } as any);
    process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-key";
  });

  const finishAnalytics = async () => {
    for (const [callback] of jest.mocked(after).mock.calls) {
      await (callback as () => Promise<void>)();
    }
  };

  it.each(["denied", "unavailable", "unconfigured"])(
    "keeps redirects and attribution but skips all analytics when admission is %s",
    async (state) => {
      if (state === "denied") mockEval.mockResolvedValue(0);
      if (state === "unavailable")
        mockEval.mockRejectedValue(new Error("unavailable"));
      if (state === "unconfigured")
        jest.mocked(createRedisClient).mockReturnValue(null);

      const response = await GET(request(), {
        params: Promise.resolve({ code: "medusa" }),
      });
      await finishAnalytics();

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://hackerai.co/");
      expect(
        readPartnerCookie(response.cookies.get(INFLUENCER_COOKIE)?.value)?.code,
      ).toBe("medusa");
      expect(mockMutation.mock.calls.length).toBe(0);
      expect(flushInfluencerAnalytics).not.toHaveBeenCalled();
    },
  );

  it("continues to count admitted repeat visits separately", async () => {
    const visitorId = "00000000-0000-4000-8000-000000000001";
    for (let visit = 0; visit < 2; visit += 1) {
      await GET(
        request({
          [INFLUENCER_VISITOR_COOKIE]: partnerCookie(
            "visitor",
            Date.now(),
            visitorId,
          ),
        }),
        { params: Promise.resolve({ code: "medusa" }) },
      );
    }
    await finishAnalytics();
    const visits = mockMutation.mock.calls
      .map(([, args]) => args)
      .filter((args) => args.visitId);
    expect(visits).toHaveLength(2);
    expect(new Set(visits.map((visit) => visit.visitId)).size).toBe(2);
    expect(visits.every((visit) => visit.visitorId === visitorId)).toBe(true);
    expect(flushInfluencerAnalytics).toHaveBeenCalledTimes(2);
  });
  it("retains the code without cookies or events while consent is pending", async () => {
    const response = await GET(request({}, "DE"), {
      params: Promise.resolve({ code: "Medusa" }),
    });
    expect(response.headers.get("location")).toBe(
      "https://hackerai.co/?ref=medusa",
    );
    expect(response.cookies.get(INFLUENCER_COOKIE)?.value).toBeUndefined();
    expect(
      response.cookies.get(INFLUENCER_VISITOR_COOKIE)?.value,
    ).toBeUndefined();
    expect(after).not.toHaveBeenCalled();
  });
  it("discards the code without tracking for declined consent and bots", async () => {
    const botRequest = request({}, "DE");
    botRequest.headers.set("user-agent", "SocialPreviewBot");
    for (const req of [
      request({ hackerai_analytics_consent: "declined" }, "DE"),
      botRequest,
    ]) {
      const response = await GET(req, {
        params: Promise.resolve({ code: "medusa" }),
      });
      expect(response.headers.get("location")).toBe("https://hackerai.co/");
      expect(response.cookies.get(INFLUENCER_COOKIE)?.value).toBeUndefined();
      expect(
        response.cookies.get(INFLUENCER_VISITOR_COOKIE)?.value,
      ).toBeUndefined();
    }
    expect(after).not.toHaveBeenCalled();
  });
  it("normalizes the slug and redirects to the app with signed attribution", async () => {
    const response = await GET(request(), {
      params: Promise.resolve({ code: "Medusa" }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://hackerai.co/");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      readPartnerCookie(response.cookies.get(INFLUENCER_COOKIE)?.value)?.code,
    ).toBe("medusa");
  });
  it("rejects malformed and inactive links", async () => {
    expect(
      (await GET(request(), { params: Promise.resolve({ code: "../bad" }) }))
        .status,
    ).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
    mockQuery.mockResolvedValue({ active: false });
    expect(
      (await GET(request(), { params: Promise.resolve({ code: "medusa" }) }))
        .status,
    ).toBe(404);
  });
  it("honors consent and preserves the first valid influencer click", async () => {
    for (const req of [
      request({}, "DE"),
      request({ hackerai_analytics_consent: "declined" }),
      request({ [INFLUENCER_COOKIE]: partnerCookie("first-partner") }),
    ]) {
      const response = await GET(req, {
        params: Promise.resolve({ code: "medusa" }),
      });
      expect(response.cookies.get(INFLUENCER_COOKIE)?.value).toBeUndefined();
    }
    const response = await GET(
      request({ hackerai_analytics_consent: "accepted" }, "DE"),
      { params: Promise.resolve({ code: "medusa" }) },
    );
    expect(
      readPartnerCookie(response.cookies.get(INFLUENCER_COOKIE)?.value)?.code,
    ).toBe("medusa");
  });
});
