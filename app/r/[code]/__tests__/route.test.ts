import { partnerCookie, readPartnerCookie } from "@/lib/influencers/cookie";
import { INFLUENCER_COOKIE } from "@/lib/influencers/policy";
const mockQuery = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery }),
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
    mockQuery.mockReset().mockResolvedValue({ active: true });
    process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-key";
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
