import { describe, expect, it, jest } from "@jest/globals";

function createRedirectResponse(url: URL) {
  const values = new Map<string, string>();
  return {
    cookies: {
      get: (name: string) => {
        const value = values.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: (name: string, value: string) => values.set(name, value),
    },
    headers: new Headers({ location: url.toString() }),
  };
}

jest.mock("next/server", () => ({
  NextResponse: { redirect: jest.fn(createRedirectResponse) },
}));

const { GET } = require("../route") as typeof import("../route");

function request({
  countryCode,
  consent,
}: {
  countryCode: string;
  consent?: "accepted" | "declined";
}) {
  return {
    url: "https://hackerai.co/invite/ABCDEF",
    headers: new Headers({ "x-vercel-ip-country": countryCode }),
    cookies: {
      get: (name: string) =>
        name === "hackerai_analytics_consent" && consent
          ? { name, value: consent }
          : undefined,
    },
  } as never;
}

const context = { params: Promise.resolve({ code: "ABCDEF" }) };

describe("GET /invite/[code]", () => {
  it("does not set referral attribution before EU consent", async () => {
    const response = await GET(request({ countryCode: "DE" }), context);

    expect(response.cookies.get("hackerai_ref")).toBeUndefined();
    expect(response.headers.get("location")).toBe(
      "https://hackerai.co/signup?referral_code=ABCDEF",
    );
  });

  it("sets referral attribution after EU consent", async () => {
    const response = await GET(
      request({ countryCode: "DE", consent: "accepted" }),
      context,
    );

    expect(response.cookies.get("hackerai_ref")?.value).toBe("ABCDEF");
    expect(response.cookies.get("hackerai_ref_at")?.value).toMatch(/^\d+$/);
  });

  it("honors rejection outside the EU", async () => {
    const response = await GET(
      request({ countryCode: "US", consent: "declined" }),
      context,
    );

    expect(response.cookies.get("hackerai_ref")).toBeUndefined();
  });
});
