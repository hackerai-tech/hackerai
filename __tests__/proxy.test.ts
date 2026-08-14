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
  cookieNames = [],
}: {
  pathname: string;
  accept?: string;
  hasSession?: boolean;
  userAgent?: string;
  method?: string;
  headers?: Record<string, string>;
  cookieNames?: string[];
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
      has: jest.fn(
        (name: string) =>
          (name === "wos-session" && hasSession) || cookieNames.includes(name),
      ),
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

  it.each([
    "/api/health/connectivity",
    "/api/health/core",
    "/api/health/trigger-agent-mode",
  ])("bypasses AuthKit for the health endpoint %s", async (pathname) => {
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname,
        hasSession: true,
      }),
    );

    expect(response).toMatchObject({ kind: "next" });
    expect(mockAuthkit).not.toHaveBeenCalled();
    expect(mockNextResponseNext).toHaveBeenCalledWith();
    expect(mockNextResponseJson).not.toHaveBeenCalled();
    expect(mockNextResponseRedirect).not.toHaveBeenCalled();
  });

  it.each(["/robots.txt", "/sitemap.xml"])(
    "bypasses AuthKit for the public SEO route %s",
    async (pathname) => {
      const { default: proxy } = await import("../proxy");

      const response = await proxy(createRequest({ pathname }));

      expect(response).toMatchObject({ kind: "next" });
      expect(mockAuthkit).not.toHaveBeenCalled();
      expect(mockNextResponseNext).toHaveBeenCalledWith();
      expect(mockNextResponseJson).not.toHaveBeenCalled();
      expect(mockNextResponseRedirect).not.toHaveBeenCalled();
    },
  );

  it("stores sanitized first-touch attribution before authentication", async () => {
    mockAuthkit.mockResolvedValue({
      session: { user: null },
      headers: new Headers(),
      authorizationUrl: "https://signin.hackerai.co/login",
    });
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname:
          "/?utm_source=github&utm_medium=social&utm_campaign=aug_launch&utm_term=private-target",
        accept: "text/html",
        userAgent: "Mozilla/5.0",
        headers: {
          referer: "https://github.com/hackerai-tech?secret=value",
        },
      }),
    );

    expect(response).toMatchObject({ kind: "next" });
    const firstTouchCookieCall = response.cookies.set.mock.calls.find(
      ([name]: [string]) => name === "hackerai_first_touch_attribution",
    );
    expect(firstTouchCookieCall).toBeDefined();
    const [, value, options] = firstTouchCookieCall!;
    expect(JSON.parse(decodeURIComponent(String(value)))).toMatchObject({
      version: 1,
      source: "github",
      medium: "social",
      campaign: "aug_launch",
      referringDomain: "github.com",
      entrySurface: "home",
    });
    expect(String(value)).not.toContain("private-target");
    expect(String(value)).not.toContain("secret");
    expect(options).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 90 * 24 * 60 * 60,
      path: "/",
    });
  });

  it("does not overwrite existing first-touch attribution", async () => {
    mockAuthkit.mockResolvedValue({
      session: { user: null },
      headers: new Headers(),
      authorizationUrl: "https://signin.hackerai.co/login",
    });
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/?utm_source=second_touch",
        accept: "text/html",
        userAgent: "Mozilla/5.0",
        cookieNames: ["hackerai_first_touch_attribution"],
      }),
    );

    expect(
      response.cookies.set.mock.calls.some(
        ([name]: [string]) => name === "hackerai_first_touch_attribution",
      ),
    ).toBe(false);
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

  it("rejects nonstandard root methods before AuthKit", async () => {
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/",
        method: "GESP",
      }),
    );

    expect(response).toMatchObject({ kind: "json" });
    expect(mockAuthkit).not.toHaveBeenCalled();
    expect(mockNextResponseJson).toHaveBeenCalledWith(
      {
        code: "method_not_allowed",
        message: "GESP is not supported for this route.",
      },
      { status: 405, headers: { Allow: "GET, HEAD, POST" } },
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

  it.each([
    ["fetch action", { "next-action": "action-id" }],
    ["multipart action", { "content-type": "multipart/form-data; boundary=x" }],
  ])(
    "rejects malformed %s origins before AuthKit without logging them",
    async (_kind, actionHeaders) => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const requestId = `iad1::${"r".repeat(200)}`;
      try {
        const { default: proxy } = await import("../proxy");

        const response = await proxy(
          createRequest({
            pathname: "/c/chat_123",
            method: "POST",
            hasSession: true,
            headers: {
              ...actionHeaders,
              origin: "https://hackerai.co, foo.example.org",
              "x-vercel-id": requestId,
            },
          }),
        );

        expect(response).toMatchObject({ kind: "json" });
        expect(mockAuthkit).not.toHaveBeenCalled();
        expect(mockNextResponseJson).toHaveBeenCalledWith(
          {
            code: "bad_request:request",
            message: "The request origin is invalid.",
          },
          { status: 400 },
        );

        const warning = String(warnSpy.mock.calls[0][0]);
        expect(JSON.parse(warning)).toMatchObject({
          level: "warn",
          event: "server_action_request_rejected",
          request_id: requestId.slice(0, 128),
          pathname: "/c/chat_123",
          reason: "malformed_origin",
        });
        expect(warning).not.toContain("foo.example.org");
        expect(warning).not.toContain(requestId);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it.each([
    ["missing fetch-action", { "next-action": "action-id" }, undefined],
    ["null fetch-action", { "next-action": "action-id" }, "null"],
    [
      "cross-origin fetch-action",
      { "next-action": "action-id" },
      "https://cross-origin.example",
    ],
    [
      "cross-origin multipart-action",
      { "content-type": "multipart/form-data; boundary=x" },
      "https://cross-origin.example",
    ],
  ])(
    "leaves the %s origin to Next CSRF validation",
    async (_kind, actionHeaders, origin) => {
      mockAuthkit.mockResolvedValue({
        session: { user: { id: "user_123" } },
        headers: new Headers(),
        authorizationUrl: undefined,
      });
      const { default: proxy } = await import("../proxy");

      const headers: Record<string, string> = { ...actionHeaders };
      if (origin !== undefined) headers.origin = origin;

      const response = await proxy(
        createRequest({
          pathname: "/c/chat_123",
          method: "POST",
          hasSession: true,
          headers,
        }),
      );

      expect(response).toMatchObject({ kind: "next" });
      expect(mockAuthkit).toHaveBeenCalledTimes(1);
    },
  );

  it("treats callback-only ended-session refresh errors as logged-out requests", async () => {
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
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
    try {
      mockAuthkit.mockImplementation((_request, options: any) => {
        options.onSessionRefreshError({ error: endedSessionError });
        return Promise.resolve({
          session: { user: { id: "stale-user" } },
          headers: new Headers(),
          authorizationUrl: undefined,
        });
      });
      const { default: proxy } = await import("../proxy");

      const response = await proxy(
        createRequest({
          pathname: "/share/d87274de-f182-4a3c-a821-c0949295af2d",
          method: "POST",
          hasSession: true,
        }),
      );

      expect(response).toMatchObject({ kind: "next" });
      expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
      expect(mockNextResponseJson).not.toHaveBeenCalled();
      expect(mockNextResponseRedirect).not.toHaveBeenCalled();
      expect(JSON.parse(String(infoSpy.mock.calls[0][0]))).toMatchObject({
        level: "info",
        event: "auth.session_refresh_ended",
        service: "hackerai-web",
        pathname: "/share/d87274de-f182-4a3c-a821-c0949295af2d",
      });
    } finally {
      infoSpy.mockRestore();
    }
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

  it("preserves session cookies when an API refresh is rate-limited", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const authkitHeaders = new Headers({
      "cache-control": "no-store",
      "set-cookie":
        "wos-session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly",
      "x-workos-session": "internal-session-value",
    });
    authkitHeaders.append(
      "set-cookie",
      "wos-auth-verifier-state=sealed-state; Path=/; HttpOnly",
    );

    try {
      mockAuthkit.mockImplementation((_request, options: any) => {
        options.onSessionRefreshError({
          error: Object.assign(new Error("Rate limit exceeded"), {
            status: 429,
          }),
        });
        return Promise.resolve({
          session: { user: null },
          headers: authkitHeaders,
          authorizationUrl: "https://auth.hackerai.co/login",
        });
      });
      const { default: proxy } = await import("../proxy");

      await proxy(
        createRequest({
          pathname: "/api/agent/resume",
          hasSession: true,
        }),
      );

      expect(mockNextResponseJson).toHaveBeenCalledWith(
        { code: "rate_limited", message: "Please retry shortly." },
        expect.objectContaining({ status: 503 }),
      );
      const responseInit = mockNextResponseJson.mock.calls[0][1] as {
        headers: Headers;
      };
      expect(responseInit.headers.get("retry-after")).toBe("5");
      expect(responseInit.headers.get("cache-control")).toBe("no-store");
      expect(responseInit.headers.get("set-cookie")).toBeNull();
      expect(responseInit.headers.get("x-workos-session")).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("preserves session cookies when a browser refresh is rate-limited", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const authkitHeaders = new Headers({
      "set-cookie":
        "wos-session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly",
      "x-workos-session": "internal-session-value",
    });

    try {
      mockAuthkit.mockImplementation((_request, options: any) => {
        options.onSessionRefreshError({
          error: Object.assign(new Error("Too many requests"), {
            status: 429,
          }),
        });
        return Promise.resolve({
          session: { user: null },
          headers: authkitHeaders,
          authorizationUrl: "https://auth.hackerai.co/login",
        });
      });
      const { default: proxy } = await import("../proxy");

      await proxy(
        createRequest({
          pathname: "/dashboard",
          accept: "text/html",
          hasSession: true,
          userAgent: "Mozilla/5.0",
        }),
      );

      expect(mockNextResponseNext).toHaveBeenCalledTimes(1);
      const responseInit = mockNextResponseNext.mock.calls[0][0] as {
        headers: Headers;
      };
      expect(responseInit.headers.get("set-cookie")).toBeNull();
      expect(responseInit.headers.get("x-workos-session")).toBeNull();
      expect(mockNextResponseRedirect).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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

  it("stops root Server Actions when session refresh has ended", async () => {
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
        pathname: "/",
        method: "POST",
        hasSession: true,
        headers: { "next-action": "billing-action" },
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
      { status: 401 },
    );
    expect(mockNextResponseNext).not.toHaveBeenCalled();
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
