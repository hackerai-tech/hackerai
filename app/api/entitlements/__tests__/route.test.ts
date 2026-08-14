import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockAuthenticate = jest.fn();
const mockRefresh = jest.fn();
const mockLoadSealedSession = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockResponseCookieSet = jest.fn();

jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
      cookies: {
        set: mockResponseCookieSet,
      },
    })),
  },
}));

jest.mock("@/app/api/workos", () => ({
  workos: {
    userManagement: {
      loadSealedSession: mockLoadSealedSession,
      listOrganizationMemberships: mockListOrganizationMemberships,
    },
  },
}));

function makeRequest(sessionCookie = "sealed-session") {
  return {
    cookies: {
      get: jest.fn((name: string) =>
        name === "wos-session" ? { value: sessionCookie } : undefined,
      ),
    },
  } as any;
}

describe("GET /api/entitlements", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WORKOS_COOKIE_PASSWORD = "cookie-password";

    mockLoadSealedSession.mockReturnValue({
      authenticate: mockAuthenticate,
      refresh: mockRefresh,
    });
    mockAuthenticate.mockResolvedValue({
      authenticated: true,
      user: { id: "user_123" },
      organizationId: "org_active",
    } as never);
    mockRefresh.mockResolvedValue({
      sealedSession: "refreshed-session",
      entitlements: ["pro-plan"],
    } as never);
  });

  it("refreshes entitlements for the active organization from the session", async () => {
    const { GET } = await import("../route");

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockLoadSealedSession).toHaveBeenCalledWith({
      cookiePassword: "cookie-password",
      sessionData: "sealed-session",
    });
    expect(mockRefresh).toHaveBeenCalledWith({
      organizationId: "org_active",
    });
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
    expect(body).toEqual({
      entitlements: ["pro-plan"],
      subscription: "pro",
    });
    expect(mockResponseCookieSet).toHaveBeenCalledWith(
      "wos-session",
      "refreshed-session",
      {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
      },
    );
  });

  it("does not select the first membership when the session has no active organization", async () => {
    mockAuthenticate.mockResolvedValueOnce({
      authenticated: true,
      user: { id: "user_123" },
    } as never);

    const { GET } = await import("../route");
    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockRefresh).toHaveBeenCalledWith();
    expect(mockListOrganizationMemberships).not.toHaveBeenCalled();
  });
});
