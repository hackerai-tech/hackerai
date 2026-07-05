import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextRequest } from "next/server";

const mockAuthkit = jest.fn();
const mockNextResponseNext = jest.fn((init?: unknown) =>
  mockCreateResponse("next", undefined, init),
);
const mockNextResponseJson = jest.fn((body: unknown, init?: unknown) =>
  mockCreateResponse("json", body, init),
);
const mockNextResponseRedirect = jest.fn((url: URL, init?: unknown) =>
  mockCreateResponse("redirect", url, init),
);

function mockCreateResponse(kind: string, body?: unknown, init?: unknown) {
  return {
    kind,
    body,
    init,
    cookies: {
      set: jest.fn(),
      delete: jest.fn(),
    },
  };
}

jest.mock("@workos-inc/authkit-nextjs", () => ({
  authkit: mockAuthkit,
}));

jest.mock("next/server", () => ({
  NextResponse: {
    next: mockNextResponseNext,
    json: mockNextResponseJson,
    redirect: mockNextResponseRedirect,
  },
}));

function createRequest({
  pathname,
  accept = "application/json",
  hasSession = false,
  userAgent = "BetterStack",
  method = "GET",
  headers = {},
}: {
  pathname: string;
  accept?: string;
  hasSession?: boolean;
  userAgent?: string;
  method?: string;
  headers?: Record<string, string>;
}): NextRequest {
  const url = new URL(pathname, "https://hackerai.co");
  return {
    method,
    nextUrl: url,
    url: url.toString(),
    headers: new Headers({
      accept,
      "user-agent": userAgent,
      ...headers,
    }),
    cookies: {
      has: jest.fn((name: string) => name === "wos-session" && hasSession),
    },
  } as unknown as NextRequest;
}

describe("proxy", () => {
  beforeEach(() => {
    jest.resetModules();
    mockAuthkit.mockReset();
    mockNextResponseNext.mockClear();
    mockNextResponseJson.mockClear();
    mockNextResponseRedirect.mockClear();
  });

  it("bypasses AuthKit for the Trigger Agent health endpoint", async () => {
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/api/health/trigger-agent-mode",
        hasSession: true,
      }),
    );

    expect(response).toMatchObject({ kind: "next" });
    expect(mockAuthkit).not.toHaveBeenCalled();
    expect(mockNextResponseNext).toHaveBeenCalledWith();
    expect(mockNextResponseJson).not.toHaveBeenCalled();
    expect(mockNextResponseRedirect).not.toHaveBeenCalled();
  });

  it("rejects non-action root POSTs before AuthKit", async () => {
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/index",
        method: "POST",
      }),
    );

    expect(response).toMatchObject({ kind: "json" });
    expect(mockAuthkit).not.toHaveBeenCalled();
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        code: "method_not_allowed",
        message: "POST is not supported for this route.",
      },
      { status: 405, headers: { Allow: "GET, HEAD" } },
    );
  });

  it("lets root Server Action POSTs continue through AuthKit", async () => {
    mockAuthkit.mockResolvedValue({
      session: { user: { id: "user_123" } },
      headers: new Headers(),
      authorizationUrl: undefined,
    });
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/",
        method: "POST",
        headers: { "next-action": "action-id" },
      }),
    );

    expect(response).toMatchObject({ kind: "next" });
    expect(mockAuthkit).toHaveBeenCalledTimes(1);
    expect(mockNextResponseJson).not.toHaveBeenCalled();
  });

  it("still requires auth for protected API routes", async () => {
    mockAuthkit.mockResolvedValue({
      session: { user: null },
      headers: new Headers(),
      authorizationUrl: "https://auth.hackerai.co/login",
    });
    const { default: proxy } = await import("../proxy");

    await proxy(
      createRequest({
        pathname: "/api/subscription-details",
        hasSession: true,
      }),
    );

    expect(mockAuthkit).toHaveBeenCalledTimes(1);
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        code: "unauthorized:auth",
        message: "You need to sign in before continuing.",
        cause: "Session expired or invalid",
      },
      expect.objectContaining({ status: 401 }),
    );
  });

  it("treats thrown ended-session refresh errors as unauthenticated home requests", async () => {
    const endedSessionError = Object.assign(
      new Error("Failed to refresh session: Error: invalid_grant"),
      {
        name: "TokenRefreshError",
        cause: {
          error: "invalid_grant",
          errorDescription: "Session has already ended.",
          rawData: {
            error: "invalid_grant",
            error_description: "Session has already ended.",
          },
        },
      },
    );
    mockAuthkit.mockRejectedValue(endedSessionError);
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/",
        accept: "text/html",
        hasSession: true,
      }),
    );

    expect(response).toMatchObject({ kind: "next" });
    expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
    expect(mockNextResponseJson).not.toHaveBeenCalled();
    expect(mockNextResponseRedirect).not.toHaveBeenCalled();
  });

  it("returns 401 when protected APIs hit thrown ended-session refresh errors", async () => {
    const endedSessionError = Object.assign(
      new Error("Failed to refresh session: Error: invalid_grant"),
      {
        name: "TokenRefreshError",
        cause: {
          error: "invalid_grant",
          errorDescription: "Session has already ended.",
        },
      },
    );
    mockAuthkit.mockRejectedValue(endedSessionError);
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/api/subscription-details",
        hasSession: true,
      }),
    );

    expect(response).toMatchObject({ kind: "json" });
    expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        code: "unauthorized:auth",
        message: "You need to sign in before continuing.",
        cause: "Session expired or invalid",
      },
      expect.objectContaining({ status: 401 }),
    );
  });

  it("redirects to login when protected browser requests hit thrown ended-session refresh errors", async () => {
    const endedSessionError = Object.assign(
      new Error("Failed to refresh session: Error: invalid_grant"),
      {
        name: "TokenRefreshError",
        cause: {
          error: "invalid_grant",
          errorDescription: "Session has already ended.",
        },
      },
    );
    mockAuthkit.mockRejectedValue(endedSessionError);
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/dashboard",
        accept: "text/html",
        hasSession: true,
      }),
    );

    expect(response).toMatchObject({ kind: "redirect" });
    expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
    expect(mockNextResponseRedirect).toHaveBeenCalledWith(
      new URL("/login", "https://hackerai.co/dashboard"),
    );
  });
});
