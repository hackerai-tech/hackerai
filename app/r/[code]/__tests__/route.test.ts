import { partnerCookie, readPartnerCookie } from "@/lib/influencers/cookie";
import { INFLUENCER_COOKIE } from "@/lib/influencers/policy";
import { INFLUENCER_VISITOR_COOKIE } from "@/lib/influencers/cookie";
import { after } from "next/server";
import {
  INFLUENCER_VISIT_COOKIE,
  parseInfluencerVisit,
} from "@/lib/influencers/visit-handoff";
import {
  captureInfluencerVisit,
  clearInfluencerVisit,
} from "@/lib/influencers/browser-visits";
import type { PostHog } from "posthog-js";
import { flushInfluencerAnalytics } from "@/lib/influencers/analytics";
const mockQuery = jest.fn();
const mockMutation = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/lib/influencers/analytics", () => ({
  flushInfluencerAnalytics: jest.fn(),
}));
jest.mock("next/server", () => ({
  after: jest.fn(),
  NextResponse: class {
    status: number;
    headers: Headers;
    cookies: any;
    constructor(_body: unknown, options: any = {}) {
      this.status = options.status ?? 200;
      this.headers = new Headers(options.headers);
      const { ResponseCookies } = jest.requireActual(
        "next/dist/compiled/@edge-runtime/cookies",
      );
      this.cookies = new ResponseCookies(this.headers);
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
    clearInfluencerVisit();
    delete process.env.INFLUENCER_ANALYTICS_DISABLED;
    process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-key";
  });

  it("hands repeated visits to the browser without writes or queue delivery", async () => {
    const visitorId = "00000000-0000-4000-8000-000000000001";
    const posthog = { capture: jest.fn(() => ({})) };
    for (let visit = 0; visit < 2; visit += 1) {
      const response = await GET(
        request({
          [INFLUENCER_COOKIE]: partnerCookie(
            "first-partner",
            Date.now(),
            visitorId,
          ),
        }),
        { params: Promise.resolve({ code: "medusa" }) },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://hackerai.co/");
      expect(response.cookies.get(INFLUENCER_COOKIE)?.value).toBeUndefined();
      expect(response.cookies.get(INFLUENCER_VISITOR_COOKIE)?.httpOnly).toBe(
        true,
      );
      expect(response.cookies.get(INFLUENCER_VISIT_COOKIE)).toEqual(
        expect.objectContaining({
          httpOnly: false,
          maxAge: 300,
          sameSite: "lax",
          path: "/",
        }),
      );
      const raw = response.cookies.get(INFLUENCER_VISIT_COOKIE)?.value;
      expect(parseInfluencerVisit(raw)).toEqual(
        expect.objectContaining({ code: "medusa", visitorId }),
      );
      const wireCookie = response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith(`${INFLUENCER_VISIT_COOKIE}=`));
      expect(wireCookie).toBeDefined();
      document.cookie = wireCookie!;
      captureInfluencerVisit(posthog as unknown as PostHog);
      captureInfluencerVisit(posthog as unknown as PostHog);
    }
    expect(after).not.toHaveBeenCalled();
    expect(mockMutation.mock.calls.length).toBe(0);
    expect(flushInfluencerAnalytics).not.toHaveBeenCalled();
    expect(posthog.capture).toHaveBeenCalledTimes(2);
    const calls = posthog.capture.mock.calls as unknown as [
      string,
      Record<string, unknown>,
      { uuid: string },
    ][];
    expect(new Set(calls.map(([, , options]) => options.uuid)).size).toBe(2);
    expect(
      calls.every(
        ([, properties]) =>
          properties.distinct_id === `influencer-visitor:${visitorId}`,
      ),
    ).toBe(true);
  });

  it("keeps signed attribution when optional analytics is disabled", async () => {
    process.env.INFLUENCER_ANALYTICS_DISABLED = "true";
    const response = await GET(request(), {
      params: Promise.resolve({ code: "medusa" }),
    });
    expect(
      readPartnerCookie(response.cookies.get(INFLUENCER_COOKIE)?.value)?.code,
    ).toBe("medusa");
    expect(
      response.cookies.get(INFLUENCER_VISIT_COOKIE)?.value,
    ).toBeUndefined();
    expect(response.cookies.get(INFLUENCER_COOKIE)?.httpOnly).toBe(true);
    expect(after).not.toHaveBeenCalled();
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
    expect(
      response.cookies.get(INFLUENCER_VISIT_COOKIE)?.value,
    ).toBeUndefined();
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
      expect(
        response.cookies.get(INFLUENCER_VISIT_COOKIE)?.value,
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
