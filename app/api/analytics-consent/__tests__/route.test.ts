import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { NextRequest } from "next/server";

const mockNextResponseJson = jest.fn(
  (body: unknown, init?: { headers?: Record<string, string> }) => ({
    headers: new Headers(init?.headers),
    json: async () => body,
  }),
);

jest.mock("next/server", () => ({
  NextResponse: {
    json: mockNextResponseJson,
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
const { GET } = jest.requireActual<typeof import("../route")>("../route");

function createRequest({
  consent,
  countryCode,
}: {
  consent?: string;
  countryCode?: string;
}): NextRequest {
  return {
    cookies: {
      get: jest.fn((name: string) =>
        name === "hackerai_analytics_consent" && consent
          ? { name, value: consent }
          : undefined,
      ),
    },
    headers: new Headers(
      countryCode ? { "x-vercel-ip-country": countryCode } : undefined,
    ),
  } as unknown as NextRequest;
}

describe("GET /api/analytics-consent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("does not require an initial choice in the United States", async () => {
    const response = await GET(createRequest({ countryCode: "US" }));

    await expect(response.json()).resolves.toEqual({
      consent: null,
      consentRequired: false,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires a choice in a covered country", async () => {
    const response = await GET(createRequest({ countryCode: "DE" }));

    await expect(response.json()).resolves.toEqual({
      consent: null,
      consentRequired: true,
    });
  });

  it("returns a saved choice", async () => {
    const response = await GET(
      createRequest({ countryCode: "DE", consent: "declined" }),
    );

    await expect(response.json()).resolves.toEqual({
      consent: "declined",
      consentRequired: true,
    });
  });

  it("fails closed in production when country data is unavailable", async () => {
    process.env.NODE_ENV = "production";

    const response = await GET(createRequest({}));

    await expect(response.json()).resolves.toEqual({
      consent: null,
      consentRequired: true,
    });
  });
});
