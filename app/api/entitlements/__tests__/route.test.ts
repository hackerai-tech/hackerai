import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockAuthenticate = jest.fn();
const mockRefresh = jest.fn();
const mockLoadSealedSession = jest.fn();
const mockListOrganizationMemberships = jest.fn();
const mockAutoPagination = jest.fn();
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
    mockListOrganizationMemberships.mockResolvedValue({
      autoPagination: mockAutoPagination,
    } as never);
    mockAutoPagination.mockResolvedValue([] as never);
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

  it("recovers entitlements from the only active membership when the session has no organization", async () => {
    mockAuthenticate.mockResolvedValueOnce({
      authenticated: true,
      user: { id: "user_123" },
    } as never);
    mockAutoPagination.mockResolvedValueOnce([
      { organizationId: "org_only" },
    ] as never);

    const { GET } = await import("../route");
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListOrganizationMemberships).toHaveBeenCalledWith({
      userId: "user_123",
      statuses: ["active"],
    });
    expect(mockAutoPagination).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith({
      organizationId: "org_only",
    });
    expect(body).toEqual({
      entitlements: ["pro-plan"],
      subscription: "pro",
    });
  });

  it("requires organization selection instead of choosing an arbitrary membership", async () => {
    mockAuthenticate.mockResolvedValueOnce({
      authenticated: true,
      user: { id: "user_123" },
    } as never);
    mockAutoPagination.mockResolvedValueOnce([
      { organizationId: "org_first" },
      { organizationId: "org_second" },
    ] as never);

    const { GET } = await import("../route");
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "Organization selection required",
      code: "organization_selection_required",
    });
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockResponseCookieSet).not.toHaveBeenCalled();
  });

  it("keeps the unscoped refresh for users with no active memberships", async () => {
    mockAuthenticate.mockResolvedValueOnce({
      authenticated: true,
      user: { id: "user_123" },
    } as never);
    mockRefresh.mockResolvedValueOnce({
      sealedSession: "refreshed-session",
      entitlements: [],
    } as never);

    const { GET } = await import("../route");
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRefresh).toHaveBeenCalledWith();
    expect(body).toEqual({
      entitlements: [],
      subscription: "free",
    });
  });

  it("does not fall back to an unscoped refresh when membership lookup is rate limited", async () => {
    mockAuthenticate.mockResolvedValueOnce({
      authenticated: true,
      user: { id: "user_123" },
    } as never);
    mockAutoPagination.mockRejectedValueOnce(
      Object.assign(new Error("Rate limit exceeded"), { status: 429 }) as never,
    );

    const { GET } = await import("../route");
    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toEqual({
      error: "Rate limited",
      entitlements: [],
      subscription: "free",
    });
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockResponseCookieSet).not.toHaveBeenCalled();
  });
});
