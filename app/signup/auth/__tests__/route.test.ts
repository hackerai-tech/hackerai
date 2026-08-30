import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCookieGet = jest.fn();
const mockParseCookie = jest.fn();
const mockCreateState = jest.fn();
const mockRedirect = jest.fn();

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({ get: mockCookieGet })),
}));
jest.mock("@/lib/analytics/acquisition-cookie", () => ({
  parseFirstTouchAttributionCookie: mockParseCookie,
}));
jest.mock("@/lib/analytics/signup-acquisition-state", () => ({
  createSignupAttributionState: mockCreateState,
}));
jest.mock("@/lib/auth/auth-redirect-intents", () => ({
  redirectToAuthorizationUrl: mockRedirect,
}));

import { getSignUpUrl } from "@workos-inc/authkit-nextjs";
const mockGetSignUpUrl = getSignUpUrl as jest.MockedFunction<
  typeof getSignUpUrl
>;

describe("GET /signup/auth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSignUpUrl.mockResolvedValue("https://signin.hackerai.co/signup");
    mockRedirect.mockReturnValue({ kind: "redirect" });
    mockCookieGet.mockReturnValue({ value: "signed-cookie" });
  });

  it("seals valid first-touch attribution into WorkOS custom state", async () => {
    const { GET } = await import("../route");
    const firstTouch = {
      version: 1,
      source: "github",
      medium: "social",
      referringDomain: "github.com",
      entrySurface: "home",
      capturedAt: "2026-08-30T12:00:00.000Z",
    };
    mockParseCookie.mockReturnValue(firstTouch);
    mockCreateState.mockReturnValue("signup-state");

    const response = await GET({
      url: "https://hackerai.co/signup/auth",
    } as Request);

    expect(mockCreateState).toHaveBeenCalledWith(firstTouch);
    expect(mockGetSignUpUrl).toHaveBeenCalledWith({ state: "signup-state" });
    expect(mockRedirect).toHaveBeenCalledWith(
      "https://signin.hackerai.co/signup",
      new URL("https://hackerai.co/signup/auth"),
    );
    expect(response).toEqual({ kind: "redirect" });
  });

  it("starts signup without attribution when the cookie is absent or invalid", async () => {
    const { GET } = await import("../route");
    mockParseCookie.mockReturnValue(null);

    await GET({ url: "https://hackerai.co/signup/auth" } as Request);

    expect(mockCreateState).not.toHaveBeenCalled();
    expect(mockGetSignUpUrl).toHaveBeenCalledWith(undefined);
  });
});
