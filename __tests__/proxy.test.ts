import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { AuthkitOptions } from "@workos-inc/authkit-nextjs";
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
const originalCookiePassword = process.env.WORKOS_COOKIE_PASSWORD;

/** Model Next's default redirect status for response-based diagnostic assertions. */
function mockCreateResponse(kind: string, body?: unknown, init?: unknown) {
  return {
    kind,
    body,
    init,
    status:
      (init as { status?: number } | undefined)?.status ??
      (kind === "redirect" ? 307 : 200),
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
  cookieValues = {},
}: {
  pathname: string;
  accept?: string;
  hasSession?: boolean;
  userAgent?: string;
  method?: string;
  headers?: Record<string, string>;
  cookieNames?: string[];
  cookieValues?: Record<string, string>;
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
      delete: jest.fn((name: string) => {
        delete cookieValues[name];
      }),
      has: jest.fn(
        (name: string) =>
          (name === "wos-session" && hasSession) ||
          cookieNames.includes(name) ||
          Object.hasOwn(cookieValues, name),
      ),
      get: jest.fn((name: string) =>
        Object.hasOwn(cookieValues, name)
          ? { name, value: cookieValues[name] }
          : undefined,
      ),
    },
  } as unknown as NextRequest;
}

describe("proxy", () => {
  it.each([
    ["POST", true],
    ["PRIVATE-METHOD-MARKER", false],
  ])(
    "records only bounded Desktop redirect context for %s",
    async (method, isAction) => {
      const info = jest.spyOn(console, "info").mockImplementation(() => {});
      try {
        const { default: proxy } = await import("../proxy");
        const response = await proxy(
          createRequest({
            pathname: "/c/private-chat-marker?secret=private-query-marker",
            userAgent: "HackerAI-Desktop private-ua-marker",
            method,
            accept: "text/html;private-accept-marker",
            headers: { "next-action": "private-action-marker" },
            cookieValues: { unrelated: "private-cookie-marker" },
          }),
        );
        expect(response).toBe(mockNextResponseRedirect.mock.results[0]?.value);
        expect(mockNextResponseRedirect).toHaveBeenCalledWith(
          new URL("https://hackerai.co/desktop-callback?error=unauthenticated"),
        );
        expect(mockAuthkit).not.toHaveBeenCalled();
        expect(response.cookies.delete).not.toHaveBeenCalledWith("wos-session");
        expect(info).toHaveBeenCalledTimes(1);
        const fields = JSON.parse(info.mock.calls[0][0] as string);
        expect(fields).toEqual({
          event: "desktop_auth_redirect_observed",
          diagnostic_version: 1,
          boundary: "proxy",
          reason: "missing_session_cookie",
          request_method: isAction ? "POST" : "OTHER",
          route_kind: "chat_page",
          next_action_header_present: true,
          accepts_html: true,
          redirect_status: 307,
          destination: "desktop_callback",
        });
        expect(JSON.stringify(fields)).not.toContain("private-");
        expect(JSON.stringify(fields)).not.toContain("PRIVATE-");
      } finally {
        info.mockRestore();
      }
    },
  );

  it("records the ended-session redirect after preserving cookie clearing", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockAuthkit.mockRejectedValue(new Error("Wrong mac prefix"));
      const { default: proxy } = await import("../proxy");
      const response = await proxy(
        createRequest({
          pathname: "/api/private-marker",
          userAgent: "HackerAI-Desktop",
          method: "POST",
          accept: "text/html",
          hasSession: true,
        }),
      );
      expect(response).toBe(mockNextResponseRedirect.mock.results[0]?.value);
      expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
      expect(JSON.parse(info.mock.calls[0][0] as string)).toMatchObject({
        reason: "ended_session",
        route_kind: "api",
        request_method: "POST",
        next_action_header_present: false,
        redirect_status: 307,
      });
    } finally {
      info.mockRestore();
      warning.mockRestore();
    }
  });

  it.each([false, true])(
    "preserves the Desktop redirect when logging throws (session=%s)",
    async (hasSession) => {
      const info = jest.spyOn(console, "info").mockImplementation(() => {
        throw new Error("logger unavailable");
      });
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        if (hasSession)
          mockAuthkit.mockRejectedValue(new Error("Wrong mac prefix"));
        const { default: proxy } = await import("../proxy");
        const response = await proxy(
          createRequest({
            pathname: "/dashboard",
            userAgent: "HackerAI-Desktop",
            method: "POST",
            accept: "text/html",
            hasSession,
          }),
        );
        expect(info).toHaveBeenCalledTimes(1);
        expect(response).toBe(mockNextResponseRedirect.mock.results[0]?.value);
        expect(response.status).toBe(307);
        if (hasSession)
          expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
      } finally {
        info.mockRestore();
        warning.mockRestore();
      }
    },
  );

  it.each([
    { method: "GET", userAgent: "HackerAI-Desktop", hasSession: false },
    { method: "HEAD", userAgent: "HackerAI-Desktop", hasSession: false },
    { method: "POST", userAgent: "Mozilla/5.0", hasSession: true },
    { method: "POST", userAgent: "HackerAI-Desktop", hasSession: true },
  ])(
    "does not log unrelated requests: $method $userAgent session=$hasSession",
    async (options) => {
      const info = jest.spyOn(console, "info").mockImplementation(() => {});
      try {
        mockAuthkit.mockResolvedValue({
          session: { user: { id: "user" } },
          headers: new Headers(),
        });
        const { default: proxy } = await import("../proxy");
        await proxy(createRequest({ pathname: "/dashboard", ...options }));
        expect(info).not.toHaveBeenCalled();
      } finally {
        info.mockRestore();
      }
    },
  );

  it("does not describe an ended-session Server Action 401 as a redirect", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockAuthkit.mockRejectedValue(new Error("Wrong mac prefix"));
      const { default: proxy } = await import("../proxy");
      const response = await proxy(
        createRequest({
          pathname: "/c/example",
          userAgent: "HackerAI-Desktop",
          method: "POST",
          accept: "text/html",
          hasSession: true,
          headers: { "next-action": "action" },
        }),
      );
      expect(response).toBe(mockNextResponseJson.mock.results[0]?.value);
      expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
      expect(response.status).toBe(401);
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      warning.mockRestore();
    }
  });

  it("does not attribute a web login redirect to the Desktop callback", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockAuthkit.mockRejectedValue(new Error("Wrong mac prefix"));
      const { default: proxy } = await import("../proxy");
      const response = await proxy(
        createRequest({
          pathname: "/dashboard",
          userAgent: "Mozilla/5.0",
          method: "POST",
          accept: "text/html",
          hasSession: true,
        }),
      );
      expect(response).toBe(mockNextResponseRedirect.mock.results[0]?.value);
      expect(mockNextResponseRedirect).toHaveBeenCalledWith(
        new URL("https://hackerai.co/login"),
      );
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      warning.mockRestore();
    }
  });

  it.each([
    [
      "preview",
      "qa-branch.vercel.app",
      "https://qa-branch.vercel.app/callback",
    ],
    [
      "preview",
      "deployment.vercel.app",
      "https://deployment.vercel.app/callback",
    ],
    ["preview", "untrusted.example", "https://deployment.vercel.app/callback"],
    // The configured QA alias keeps its own callback; look-alikes do not.
    ["preview", "preview.hackerai.co", "https://preview.hackerai.co/callback"],
    [
      "preview",
      "preview.hackerai.co.evil.example",
      "https://deployment.vercel.app/callback",
    ],
    ["production", "qa-branch.vercel.app", undefined],
    ["production", "preview.hackerai.co", undefined],
  ])(
    "keeps auth on a trusted Preview branch origin (%s / %s)",
    async (environment, host, redirectUri) => {
      const keys = [
        "VERCEL_ENV",
        "VERCEL_URL",
        "VERCEL_BRANCH_URL",
        "PREVIEW_QA_HOST",
      ] as const;
      const previous = Object.fromEntries(
        keys.map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, {
        VERCEL_ENV: environment,
        VERCEL_URL: "deployment.vercel.app",
        VERCEL_BRANCH_URL: "qa-branch.vercel.app",
        PREVIEW_QA_HOST: "preview.hackerai.co",
      });
      mockAuthkit.mockResolvedValue({
        session: { user: { id: "user" } },
        headers: new Headers(),
      });
      try {
        const { default: proxy } = await import("../proxy");
        await proxy(
          createRequest({
            pathname: `https://${host}/c/goal-chat`,
            accept: "text/html",
            userAgent: "Mozilla/5.0",
            hasSession: true,
          }),
        );
        expect(mockAuthkit).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ redirectUri }),
        );
      } finally {
        for (const key of keys) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
      }
    },
  );

  afterAll(() => {
    if (originalCookiePassword === undefined) {
      delete process.env.WORKOS_COOKIE_PASSWORD;
    } else {
      process.env.WORKOS_COOKIE_PASSWORD = originalCookiePassword;
    }
  });

  beforeEach(() => {
    jest.resetModules();
    mockAuthkit.mockReset();
    mockNextResponseNext.mockClear();
    mockNextResponseJson.mockClear();
    mockNextResponseRedirect.mockClear();
    process.env.WORKOS_COOKIE_PASSWORD =
      "test-cookie-password-with-32-characters";
  });

  it.each([
    ["/", "GET", "root"],
    ["/login?secret=private-query-marker", "GET", "login"],
    ["/c/private-chat-marker", "POST", "chat_page"],
    ["/api/private-path-marker", "PRIVATE-METHOD-MARKER", "api"],
    ["/private-path-marker", "GET", "other_page"],
  ])(
    "observes unexpected AuthKit failure without private contents: %s",
    async (pathname, method, routeKind) => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
      const oldBuild = process.env.VERCEL_GIT_COMMIT_SHA;
      const oldEnvironment = process.env.VERCEL_ENV;
      process.env.VERCEL_GIT_COMMIT_SHA = "A".repeat(40);
      process.env.VERCEL_ENV = "production";
      const error = Object.assign(new Error("private-error-marker"), {
        name: "private-name-marker",
        status: 503,
        code: "private-code-marker",
        cause: Object.assign(new TypeError("private-cause-marker"), {
          code: "ECONNRESET",
        }),
      });
      try {
        mockAuthkit.mockRejectedValueOnce(error);
        const { default: proxy } = await import("../proxy");
        await expect(
          proxy(
            createRequest({
              pathname,
              method,
              cookieValues: { unrelated: "private-cookie-marker" },
              headers: {
                "x-vercel-id": "arn1::gtrbx-1794282623256-a92d4497977c",
                authorization: "private-token-marker",
              },
            }),
          ),
        ).rejects.toBe(error);
        expect(mockAuthkit).toHaveBeenCalledTimes(1);
        expect(mockNextResponseNext).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalledTimes(1);
        const encoded = warning.mock.calls[0][0] as string;
        expect(encoded).not.toContain("private-");
        expect(JSON.parse(encoded)).toMatchObject({
          event: "proxy_authkit_failure_context",
          diagnostic_version: 1,
          boundary: "proxy",
          phase: "unexpected_initial_authkit",
          route_kind: routeKind,
          request_method: method === "PRIVATE-METHOD-MARKER" ? "OTHER" : method,
          vercel_request_id: "arn1::gtrbx-1794282623256-a92d4497977c",
          web_build_commit: "a".repeat(40),
          environment: "production",
          auth_refresh_error_kind: "other_error",
          auth_refresh_error_status: 503,
          auth_refresh_error_code: "other",
          auth_refresh_cause_kind: "TypeError",
          auth_refresh_cause_code: "ECONNRESET",
        });
        // A thrown AuthKit error never passed through the refresh callback.
        expect(JSON.parse(encoded)).not.toHaveProperty("auth_refresh_stage");
        expect(JSON.parse(encoded)).not.toHaveProperty(
          "auth_refresh_stage_diagnostic_version",
        );
      } finally {
        warning.mockRestore();
        if (oldBuild === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
        else process.env.VERCEL_GIT_COMMIT_SHA = oldBuild;
        if (oldEnvironment === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = oldEnvironment;
      }
    },
  );

  it("drops malformed correlation fields and preserves unreadable diagnostic errors", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    const oldBuild = process.env.VERCEL_GIT_COMMIT_SHA;
    const oldEnvironment = process.env.VERCEL_ENV;
    process.env.VERCEL_GIT_COMMIT_SHA = "private-build-marker";
    process.env.VERCEL_ENV = "private-environment-marker";
    const error = Object.defineProperty(
      new Error("private-error-marker"),
      "code",
      {
        get() {
          throw new Error("private-getter-marker");
        },
      },
    );
    try {
      mockAuthkit.mockRejectedValueOnce(error);
      const { default: proxy } = await import("../proxy");
      await expect(
        proxy(
          createRequest({
            pathname: "/login",
            headers: { "x-vercel-id": "private-header-marker" },
          }),
        ),
      ).rejects.toBe(error);
      expect(warning).toHaveBeenCalledTimes(1);
      const encoded = warning.mock.calls[0][0] as string;
      expect(encoded).not.toContain("private-");
      const fields = JSON.parse(encoded);
      expect(fields).toMatchObject({
        environment: "unknown",
        auth_refresh_error_kind: "unreadable_error",
      });
      expect(fields).not.toHaveProperty("vercel_request_id");
      expect(fields).not.toHaveProperty("web_build_commit");
    } finally {
      warning.mockRestore();
      if (oldBuild === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
      else process.env.VERCEL_GIT_COMMIT_SHA = oldBuild;
      if (oldEnvironment === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = oldEnvironment;
    }
  });

  it("preserves the original unexpected AuthKit error if the diagnostic logger fails", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const error = new Error("original unexpected failure");
    try {
      mockAuthkit.mockRejectedValueOnce(error);
      const { default: proxy } = await import("../proxy");
      await expect(proxy(createRequest({ pathname: "/login" }))).rejects.toBe(
        error,
      );
      expect(mockAuthkit).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    "/abuse",
    "/api/abuse",
    "/api/analytics-consent",
    "/api/health/connectivity",
    "/api/health/core",
    "/api/health/trigger-agent-mode",
    "/api/health/trigger-reports",
    "/api/cron/platform-costs/convex",
    "/api/cron/platform-costs/posthog",
    "/api/cron/platform-costs/vercel",
    "/api/cron/subscription-pauses",
    "/api/cron/trigger-health",
  ])(
    "bypasses AuthKit for the public or independently authenticated endpoint %s",
    async (pathname) => {
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
    },
  );

  it("passes a cookie-free native operation redemption to its one-time route", async () => {
    const { default: proxy } = await import("../proxy");
    const response = await proxy(
      createRequest({
        pathname: "/api/desktop/authorized-operation",
        method: "POST",
        hasSession: false,
      }),
    );
    expect(response).toMatchObject({ kind: "next" });
    expect(mockAuthkit).not.toHaveBeenCalled();
    expect(mockNextResponseNext).toHaveBeenCalledWith();
  });

  it.each([
    "/api/internal/user-research",
    "/api/internal/influencers/partners",
    "/api/internal/egress-telemetry",
  ])(
    "bypasses AuthKit for independently authenticated gateway %s",
    async (pathname) => {
      const { default: proxy } = await import("../proxy");

      const response = await proxy(
        createRequest({
          pathname,
          method: "POST",
        }),
      );

      expect(response).toMatchObject({ kind: "next" });
      expect(mockAuthkit).not.toHaveBeenCalled();
      expect(mockNextResponseNext).toHaveBeenCalledWith();
      expect(mockNextResponseJson).not.toHaveBeenCalled();
      expect(mockNextResponseRedirect).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/api/internal/user-research/status",
    "/api/internal/egress-telemetry/batches",
    "/api/internal/egress-telemetry-read",
  ])(
    "does not bypass AuthKit for sibling internal API path %s",
    async (pathname) => {
      mockAuthkit.mockResolvedValue({
        session: { user: null },
        headers: new Headers(),
        authorizationUrl: "https://auth.hackerai.co/login",
      });
      const { default: proxy } = await import("../proxy");

      await proxy(createRequest({ pathname, method: "POST" }));

      expect(mockAuthkit).toHaveBeenCalledTimes(1);
      expect(mockNextResponseJson).toHaveBeenCalledWith(
        {
          code: "unauthorized:auth",
          message: "You need to sign in before continuing.",
          cause: "Session expired or invalid",
        },
        expect.objectContaining({ status: 401 }),
      );
    },
  );

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

  it.each(["/product", "/pricing"])(
    "serves the public discovery page %s without authentication",
    async (pathname) => {
      mockAuthkit.mockResolvedValue({
        session: { user: null },
        headers: new Headers(),
        authorizationUrl: "https://signin.hackerai.co/login",
      });
      const { default: proxy } = await import("../proxy");

      const response = await proxy(
        createRequest({
          pathname,
          accept: "text/html",
          userAgent: "Mozilla/5.0",
        }),
      );

      expect(response).toMatchObject({ kind: "next" });
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
    const { parseFirstTouchAttributionCookie } =
      await import("@/lib/analytics/acquisition-cookie");
    expect(parseFirstTouchAttributionCookie(String(value))).toMatchObject({
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

  it("does not set optional attribution cookies before EU consent", async () => {
    mockAuthkit.mockResolvedValue({
      session: { user: null },
      headers: new Headers(),
      authorizationUrl: "https://signin.hackerai.co/login",
    });
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/?utm_source=github&referral_code=ABCDEF",
        accept: "text/html",
        userAgent: "Mozilla/5.0",
        headers: { "x-vercel-ip-country": "DE" },
      }),
    );

    expect(response.cookies.set).not.toHaveBeenCalled();
    expect(response.cookies.delete).toHaveBeenCalledWith(
      "hackerai_first_touch_attribution",
    );
    expect(response.cookies.delete).toHaveBeenCalledWith("hackerai_ref");
    expect(response.cookies.delete).toHaveBeenCalledWith("hackerai_ref_at");
  });

  it("sets optional attribution cookies after EU consent", async () => {
    mockAuthkit.mockResolvedValue({
      session: { user: null },
      headers: new Headers(),
      authorizationUrl: "https://signin.hackerai.co/login",
    });
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/?utm_source=github&referral_code=ABCDEF",
        accept: "text/html",
        userAgent: "Mozilla/5.0",
        headers: { "x-vercel-ip-country": "DE" },
        cookieValues: { hackerai_analytics_consent: "accepted" },
      }),
    );

    expect(response.cookies.set).toHaveBeenCalledWith(
      "hackerai_ref",
      "ABCDEF",
      expect.any(Object),
    );
    expect(
      response.cookies.set.mock.calls.some(
        ([name]: [string]) => name === "hackerai_first_touch_attribution",
      ),
    ).toBe(true);
  });

  it("honors an analytics rejection outside the EU", async () => {
    mockAuthkit.mockResolvedValue({
      session: { user: null },
      headers: new Headers(),
      authorizationUrl: "https://signin.hackerai.co/login",
    });
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/?utm_source=github",
        accept: "text/html",
        userAgent: "Mozilla/5.0",
        headers: { "x-vercel-ip-country": "US" },
        cookieValues: { hackerai_analytics_consent: "declined" },
      }),
    );

    expect(response.cookies.set).not.toHaveBeenCalled();
    expect(response.cookies.delete).toHaveBeenCalledWith(
      "hackerai_first_touch_attribution",
    );
  });

  it("does not store attribution for likely bot traffic", async () => {
    mockAuthkit.mockResolvedValue({
      session: { user: null },
      headers: new Headers(),
      authorizationUrl: "https://signin.hackerai.co/login",
    });
    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/?utm_source=bot_campaign",
        accept: "text/html",
        userAgent: "Googlebot/2.1",
      }),
    );

    expect(
      response.cookies.set.mock.calls.some(
        ([name]: [string]) => name === "hackerai_first_touch_attribution",
      ),
    ).toBe(false);
  });

  it("preserves assistant first-touch attribution during signup", async () => {
    mockAuthkit.mockResolvedValue({
      session: { user: null },
      headers: new Headers(),
      authorizationUrl: "https://signin.hackerai.co/login",
    });
    const { serializeSignedFirstTouchAttribution } =
      await import("@/lib/analytics/acquisition-cookie");
    const assistantFirstTouch = serializeSignedFirstTouchAttribution({
      version: 1,
      source: "chatgpt",
      medium: "campaign",
      referringDomain: "$direct",
      entrySurface: "product",
      capturedAt: "2026-09-01T12:00:00.000Z",
    });
    expect(assistantFirstTouch).not.toBeNull();

    const { default: proxy } = await import("../proxy");

    const response = await proxy(
      createRequest({
        pathname: "/signup?utm_source=google",
        accept: "text/html",
        userAgent: "Mozilla/5.0",
        cookieValues: {
          hackerai_first_touch_attribution: assistantFirstTouch!,
        },
      }),
    );

    expect(response.cookies.delete).not.toHaveBeenCalledWith(
      "hackerai_first_touch_attribution",
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

  it.each([true, false])(
    "logs AuthKit's transient classification (%s) and keeps a transient session retryable",
    async (isTransient) => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const sessionCookie = isTransient
        ? "wos-session=existing-session; Path=/; HttpOnly"
        : "wos-session=; Max-Age=0; Path=/; HttpOnly";
      const request = createRequest({
        pathname: "/api/subscription-details",
        hasSession: true,
      });

      try {
        mockAuthkit.mockImplementation((_request, options: any) => {
          options.onSessionRefreshError({
            error: Object.assign(
              new Error("Refresh failed", {
                cause: Object.assign(new TypeError("private-refresh-cause"), {
                  status: 503,
                  code: "ECONNRESET",
                }),
              }),
              { status: "400" },
            ),
            isTransient,
          });
          return Promise.resolve({
            session: { user: null },
            headers: new Headers({ "set-cookie": sessionCookie }),
            authorizationUrl: "https://auth.hackerai.co/login",
          });
        });
        const { default: proxy } = await import("../proxy");

        await proxy(request);

        expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
          event: "auth.session_refresh_failed",
          error: "Refresh failed",
          is_transient: isTransient,
          auth_refresh_diagnostic_version: 2,
          auth_refresh_error_kind: "Error",
          auth_refresh_error_status: null,
          auth_refresh_error_status_shape: "non_numeric",
          auth_refresh_error_code: "none",
          auth_refresh_cause_kind: "TypeError",
          auth_refresh_cause_status: 503,
          auth_refresh_cause_status_shape: "integer",
          auth_refresh_cause_code: "ECONNRESET",
        });
        expect(String(warnSpy.mock.calls[0][0])).not.toContain(
          "private-refresh-cause",
        );
        // A transient failure is not a session expiry, so it must not read as signed out.
        expect(mockNextResponseJson).toHaveBeenCalledWith(
          isTransient
            ? { code: "rate_limited", message: "Please retry shortly." }
            : {
                code: "unauthorized:auth",
                message: "You need to sign in before continuing.",
                cause: "Session expired or invalid",
              },
          expect.objectContaining({ status: isTransient ? 503 : 401 }),
        );
        const responseInit = mockNextResponseJson.mock.calls[0][1] as {
          headers: Headers;
        };
        expect(responseInit.headers.get("set-cookie")).toBe(sessionCookie);
        expect(request.cookies.delete).not.toHaveBeenCalled();
        expect(mockAuthkit).toHaveBeenCalledTimes(1);
        expect(mockNextResponseRedirect).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it.each<[string, unknown, string]>([
    [
      "before the SDK request",
      "before_refresh_request",
      "before_refresh_request",
    ],
    ["during the SDK request", "refresh_request", "refresh_request"],
    [
      "after the SDK response",
      "after_refresh_response",
      "after_refresh_response",
    ],
    ["from an older AuthKit build", undefined, "unavailable"],
    ["with private text", "private-stage-marker eyJhbGciOi", "unavailable"],
    ["with a near-miss label", "Refresh_Request", "unavailable"],
    [
      "with a non-string value",
      { toString: () => "refresh_request" },
      "unavailable",
    ],
  ])(
    "adds only a closed refresh stage %s to the existing warning",
    async (_case, refreshStage, expectedStage) => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const sessionCookie = "wos-session=; Max-Age=0; Path=/; HttpOnly";
      const jwtInvalid = Object.assign(
        new Error(
          "JWTs must use Compact JWS serialization, JWT must be a string",
        ),
        { name: "JWTInvalid", code: "ERR_JWT_INVALID" },
      );
      try {
        mockAuthkit.mockImplementation((_request, options: any) => {
          options.onSessionRefreshError({
            error: jwtInvalid,
            isTransient: false,
            refreshStage,
          });
          return Promise.resolve({
            session: { user: null },
            headers: new Headers({ "set-cookie": sessionCookie }),
            authorizationUrl: "https://auth.hackerai.co/login",
          });
        });
        const { default: proxy } = await import("../proxy");
        const request = createRequest({
          pathname: "/api/subscription-details",
          hasSession: true,
        });

        await proxy(request);

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const encoded = String(warnSpy.mock.calls[0][0]);
        expect(encoded).not.toContain("private-");
        expect(encoded).not.toContain("eyJ");
        expect(JSON.parse(encoded)).toMatchObject({
          event: "auth.session_refresh_failed",
          is_transient: false,
          auth_refresh_diagnostic_version: 2,
          auth_refresh_error_kind: "JWTInvalid",
          auth_refresh_error_code: "ERR_JWT_INVALID",
          auth_refresh_stage_diagnostic_version: 1,
          auth_refresh_stage: expectedStage,
        });
        expect(mockNextResponseJson).toHaveBeenCalledTimes(1);
        expect(mockNextResponseJson).toHaveBeenCalledWith(
          {
            code: "unauthorized:auth",
            message: "You need to sign in before continuing.",
            cause: "Session expired or invalid",
          },
          expect.objectContaining({ status: 401 }),
        );
        const responseInit = mockNextResponseJson.mock.calls[0][1] as {
          headers: Headers;
        };
        expect(responseInit.headers.get("set-cookie")).toBe(sessionCookie);
        expect(request.cookies.delete).not.toHaveBeenCalled();
        expect(mockNextResponseRedirect).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it.each([
    [
      "invalid refresh token",
      {
        status: 400,
        error: "invalid_grant",
        errorDescription: "Invalid refresh token.",
      },
    ],
    [
      "ended session",
      {
        error: "invalid_grant",
        errorDescription: "Session has already ended.",
      },
    ],
    ["rate limit", Object.assign(new Error("Rate limit"), { status: 429 })],
  ])(
    "keeps the %s refresh branch free of stage metadata",
    async (_case, error) => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
      try {
        mockAuthkit.mockImplementation((_request, options: any) => {
          options.onSessionRefreshError({
            error,
            isTransient: false,
            refreshStage: "refresh_request",
          });
          return Promise.resolve({
            session: { user: null },
            headers: new Headers(),
            authorizationUrl: "https://auth.hackerai.co/login",
          });
        });
        const { default: proxy } = await import("../proxy");

        await proxy(
          createRequest({
            pathname: "/api/subscription-details",
            hasSession: true,
          }),
        );

        const logged = [...warnSpy.mock.calls, ...infoSpy.mock.calls].map(
          (call) => String(call[0]),
        );
        expect(logged).toHaveLength(1);
        expect(logged[0]).not.toContain("auth.session_refresh_failed");
        expect(logged[0]).not.toContain("auth_refresh_stage");
      } finally {
        warnSpy.mockRestore();
        infoSpy.mockRestore();
      }
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

  describe("refresh that WorkOS could not answer", () => {
    let warn: ReturnType<typeof jest.spyOn>;
    beforeEach(() => {
      warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    // AuthKit's shape after the bounded SDK gives up on a stalled refresh: no
    // session, only its PKCE cookie, and the session cookie left in place.
    function mockTransientRefresh(isTransient: boolean) {
      mockAuthkit.mockImplementation((_request, options: any) => {
        options.onSessionRefreshError({
          error: Object.assign(new Error("Error: Request timeout"), {
            name: "OauthException",
            status: 408,
            error: "Request timeout",
          }),
          isTransient,
          refreshStage: "refresh_request",
        });
        return Promise.resolve({
          session: { user: null },
          headers: new Headers({
            "set-cookie": "wos-auth-verifier=sealed-state; Path=/; HttpOnly",
          }),
          authorizationUrl: "https://auth.hackerai.co/login",
        });
      });
    }

    function expectSessionCookieKept(response: any, init: any) {
      expect(response.cookies.delete).not.toHaveBeenCalledWith("wos-session");
      expect(init.headers.get("set-cookie") ?? "").not.toContain(
        "wos-session=",
      );
    }

    it("asks API clients to retry instead of answering 401", async () => {
      mockTransientRefresh(true);
      const { default: proxy } = await import("../proxy");

      const response = await proxy(
        createRequest({ pathname: "/api/agent", hasSession: true }),
      );

      expect(mockNextResponseJson).toHaveBeenCalledTimes(1);
      const [body, init] = mockNextResponseJson.mock.calls[0] as [
        unknown,
        { status: number; headers: Headers },
      ];
      expect(body).toEqual({
        code: "rate_limited",
        message: "Please retry shortly.",
      });
      expect(init.status).toBe(503);
      expect(init.headers.get("retry-after")).toBe("5");
      expectSessionCookieKept(response, init);
      // The existing categorical refresh diagnostic identifies the timeout.
      const fields = JSON.parse(warn.mock.calls[0][0] as string);
      expect(fields).toMatchObject({
        event: "auth.session_refresh_failed",
        is_transient: true,
        auth_refresh_error_kind: "OauthException",
        auth_refresh_error_status: 408,
        auth_refresh_stage: "refresh_request",
      });
    });

    it("lets a browser page load without a login redirect", async () => {
      mockTransientRefresh(true);
      const { default: proxy } = await import("../proxy");

      const response = await proxy(
        createRequest({
          pathname: "/c/chat-1",
          accept: "text/html",
          hasSession: true,
          userAgent: "Mozilla/5.0",
        }),
      );

      expect(mockNextResponseRedirect).not.toHaveBeenCalled();
      expect(mockNextResponseNext).toHaveBeenCalledTimes(1);
      const init = mockNextResponseNext.mock.calls[0][0] as {
        request: { headers: Headers };
        headers: Headers;
      };
      // No session context is forwarded, so the page stays unauthenticated.
      expect(init.request.headers.get("x-workos-session")).toBeNull();
      expectSessionCookieKept(response, init);
    });

    it("still answers 401 when the refresh failure is terminal", async () => {
      mockTransientRefresh(false);
      const { default: proxy } = await import("../proxy");

      await proxy(createRequest({ pathname: "/api/agent", hasSession: true }));

      expect(mockNextResponseJson).toHaveBeenCalledWith(
        expect.objectContaining({ code: "unauthorized:auth" }),
        expect.objectContaining({ status: 401 }),
      );
    });
  });

  describe("malformed session cookie recovery", () => {
    const invalidCookie = "bad*1*a*b*c*d*e*f";

    it.each(["/", "/callback", "/share/example", "/signup"])(
      "rebuilds anonymous AuthKit context once for %s",
      async (pathname) => {
        const warning = jest
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        try {
          const request = createRequest({
            pathname,
            accept: "text/html",
            cookieValues: { "wos-session": invalidCookie, harmless: "keep" },
            headers: { "x-workos-session": "untrusted-session-header" },
          });
          const anonymousHeaders = new Headers({
            "x-workos-middleware": "true",
            "set-cookie": "wos-pkce=anonymous-state; Path=/; HttpOnly",
          });
          mockAuthkit
            .mockRejectedValueOnce(new Error("Wrong mac prefix"))
            .mockImplementationOnce((recoveredRequest: unknown) => {
              const recovered = recoveredRequest as NextRequest;
              expect(recovered.cookies.get("wos-session")).toBeUndefined();
              expect(recovered.cookies.get("harmless")?.value).toBe("keep");
              expect(recovered.headers.has("x-workos-session")).toBe(false);
              return Promise.resolve({
                session: { user: null },
                headers: anonymousHeaders,
                authorizationUrl: "https://auth.example/sign-in",
              });
            });
          const { default: proxy } = await import("../proxy");
          const response = await proxy(request);

          expect(response).toMatchObject({ kind: "next" });
          expect(mockAuthkit).toHaveBeenCalledTimes(2);
          expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
          const init = mockNextResponseNext.mock.calls[0]?.[0] as {
            request: { headers: Headers };
            headers: Headers;
          };
          expect(init.request.headers.get("x-workos-middleware")).toBe("true");
          expect(init.request.headers.has("x-workos-session")).toBe(false);
          expect(init.headers.get("set-cookie")).toContain("wos-pkce=");
          expect(warning).toHaveBeenCalledTimes(1);
          expect(JSON.parse(warning.mock.calls[0]?.[0] as string)).toEqual({
            event: "auth.invalid_session_cookie",
            boundary: "proxy",
            reason: "wrong_mac_prefix",
          });
        } finally {
          warning.mockRestore();
        }
      },
    );

    it.each([
      {
        pathname: "/api/access-token",
        accept: "application/json",
        kind: "json",
        status: 401,
      },
      {
        pathname: "/c/example",
        accept: "text/html",
        kind: "redirect",
        destination: "/login",
      },
      {
        pathname: "/c/example",
        accept: "text/html",
        userAgent: "HackerAI-Desktop",
        kind: "redirect",
        destination: "/desktop-callback?error=unauthenticated",
      },
      {
        pathname: "/",
        method: "POST",
        headers: { "next-action": "action" },
        kind: "json",
        status: 401,
      },
    ])(
      "keeps terminal authentication for $pathname $kind",
      async (testCase) => {
        const warning = jest
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        try {
          mockAuthkit.mockRejectedValue(new Error("Wrong mac prefix"));
          const { default: proxy } = await import("../proxy");
          const response = await proxy(
            createRequest({
              ...testCase,
              cookieValues: { "wos-session": invalidCookie },
            }),
          );
          expect(mockAuthkit).toHaveBeenCalledTimes(1);
          expect(response).toMatchObject({ kind: testCase.kind });
          expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
          expect(mockNextResponseNext).not.toHaveBeenCalled();
          if (testCase.status)
            expect(response).toMatchObject({
              init: { status: testCase.status },
            });
          if (testCase.destination)
            expect(mockNextResponseRedirect).toHaveBeenCalledWith(
              new URL(testCase.destination, "https://hackerai.co"),
            );
        } finally {
          warning.mockRestore();
        }
      },
    );

    it.each([new Error("Wrong mac prefix"), new Error("provider unavailable")])(
      "propagates anonymous recovery failure without retrying again: %s",
      async (recoveryError) => {
        const warning = jest
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        try {
          mockAuthkit
            .mockRejectedValueOnce(new Error("Wrong mac prefix"))
            .mockRejectedValueOnce(recoveryError);
          const { default: proxy } = await import("../proxy");
          await expect(
            proxy(
              createRequest({
                pathname: "/",
                cookieValues: { "wos-session": invalidCookie },
              }),
            ),
          ).rejects.toBe(recoveryError);
          expect(mockAuthkit).toHaveBeenCalledTimes(2);
          expect(mockNextResponseNext).not.toHaveBeenCalled();
          expect(warning).toHaveBeenLastCalledWith(
            expect.stringContaining('"phase":"anonymous_context_retry"'),
          );
        } finally {
          warning.mockRestore();
        }
      },
    );

    it.each([
      { error: new Error("Wrong mac prefix"), hasSession: false },
      { error: new Error("Unknown authentication failure"), hasSession: true },
      { error: new Error("provider: Wrong mac prefix"), hasSession: true },
      { error: { message: "Wrong mac prefix" }, hasSession: true },
    ])(
      "preserves unknown errors or missing-cookie failures",
      async ({ error, hasSession }) => {
        mockAuthkit.mockRejectedValueOnce(error);
        const { default: proxy } = await import("../proxy");
        await expect(
          proxy(createRequest({ pathname: "/", hasSession })),
        ).rejects.toBe(error);
        expect(mockAuthkit).toHaveBeenCalledTimes(1);
        expect(mockNextResponseNext).not.toHaveBeenCalled();
      },
    );
  });

  describe("Desktop sign-in proxy handoff", () => {
    const requestId = "iad1::fra1::abc12-1794282623256-a92d4497977c";
    const privateMarker = "private-sign-in-canary";
    const anonymousAuthkit = {
      session: { user: null },
      headers: new Headers(),
    };

    it.each([
      ["/desktop-login", "desktop_login", "authkit_pass_through"],
      [
        "/api/auth/desktop-callback",
        "desktop_oauth_callback",
        "authkit_pass_through",
      ],
      ["/desktop-login", "desktop_login", "ended_session"],
      [
        "/api/auth/desktop-callback",
        "desktop_oauth_callback",
        "anonymous_context_retry",
      ],
    ])(
      "records only bounded join fields for %s through %s (%s)",
      async (pathname, routeKind, branch) => {
        const info = jest.spyOn(console, "info").mockImplementation(() => {});
        const warning = jest
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        const env = jest.replaceProperty(process, "env", {
          ...process.env,
          VERCEL_GIT_COMMIT_SHA: "B".repeat(40),
        });
        try {
          mockAuthkit.mockResolvedValue(anonymousAuthkit);
          if (branch === "ended_session") {
            mockAuthkit.mockRejectedValueOnce({
              name: "TokenRefreshError",
              isTransient: false,
              cause: {
                status: 400,
                error: "invalid_grant",
                errorDescription: "Invalid refresh token.",
              },
            });
          } else if (branch === "anonymous_context_retry") {
            mockAuthkit.mockRejectedValueOnce(new Error("Wrong mac prefix"));
          }

          const { default: proxy } = await import("../proxy");
          const response = await proxy(
            createRequest({
              pathname: `${pathname}?code=${privateMarker}&state=${privateMarker}`,
              headers: {
                "x-vercel-id": requestId,
                "x-unrelated": privateMarker,
              },
              cookieValues: { "wos-session": privateMarker },
            }),
          );

          expect(response).toBe(mockNextResponseNext.mock.results[0]?.value);
          expect(info).toHaveBeenCalledTimes(1);
          const encoded = info.mock.calls[0][0] as string;
          expect(encoded).not.toContain(privateMarker);
          expect(JSON.parse(encoded)).toEqual({
            event: "desktop_sign_in_proxy_handoff",
            diagnostic_version: 1,
            boundary: "proxy",
            route_kind: routeKind,
            branch,
            vercel_request_id: requestId,
            web_build_commit: "b".repeat(40),
          });
        } finally {
          env.restore();
          warning.mockRestore();
          info.mockRestore();
        }
      },
    );

    it.each([
      { pathname: "/desktop-login", method: "POST", id: requestId },
      { pathname: "/desktop-callback", method: "GET", id: requestId },
      {
        pathname: "/api/auth/desktop-callback",
        method: "GET",
        id: privateMarker,
      },
    ])(
      "does not log an unrelated or unjoinable $method $pathname",
      async ({ pathname, method, id }) => {
        const info = jest.spyOn(console, "info").mockImplementation(() => {});
        try {
          mockAuthkit.mockResolvedValue(anonymousAuthkit);
          const { default: proxy } = await import("../proxy");
          await proxy(
            createRequest({ pathname, method, headers: { "x-vercel-id": id } }),
          );
          expect(info).not.toHaveBeenCalled();
        } finally {
          info.mockRestore();
        }
      },
    );

    it("keeps a proxy throw distinct from a completed handoff", async () => {
      const info = jest.spyOn(console, "info").mockImplementation(() => {});
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const error = new Error("AuthKit unavailable");
        mockAuthkit.mockRejectedValue(error);
        const { default: proxy } = await import("../proxy");
        await expect(
          proxy(
            createRequest({
              pathname: "/api/auth/desktop-callback",
              headers: { "x-vercel-id": requestId },
            }),
          ),
        ).rejects.toBe(error);
        expect(mockNextResponseNext).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(warning.mock.calls[0]?.[0]).toContain(
          "proxy_authkit_failure_context",
        );
      } finally {
        warning.mockRestore();
        info.mockRestore();
      }
    });

    it("preserves the pass-through response when logging throws", async () => {
      const info = jest.spyOn(console, "info").mockImplementation(() => {
        throw new Error("logger unavailable");
      });
      try {
        mockAuthkit.mockResolvedValue(anonymousAuthkit);
        const { default: proxy } = await import("../proxy");
        const response = await proxy(
          createRequest({
            pathname: "/desktop-login",
            headers: { "x-vercel-id": requestId },
          }),
        );
        expect(info).toHaveBeenCalledTimes(1);
        expect(response).toBe(mockNextResponseNext.mock.results[0]?.value);
      } finally {
        info.mockRestore();
      }
    });
  });

  describe("public page auth context provenance", () => {
    const requestId = "iad1::fra1::abc12-1794282623256-a92d4497977c";
    const canary = "private-canary-marker";

    async function runPublicPage({
      pathname = "/",
      method = "GET",
      hasSession = false,
      incomingContext = true,
      sdkContext = false,
      vercelId = requestId,
    }: {
      pathname?: string;
      method?: string;
      hasSession?: boolean;
      incomingContext?: boolean;
      sdkContext?: boolean;
      vercelId?: string;
    } = {}) {
      mockAuthkit.mockResolvedValue({
        session: { user: hasSession ? { id: "user" } : null },
        headers: new Headers({
          "x-workos-middleware": "true",
          ...(sdkContext ? { "x-workos-session": "sdk-present" } : {}),
        }),
      });
      const { default: proxy } = await import("../proxy");
      const response = await proxy(
        createRequest({
          pathname: `${pathname}?utm=${canary}`,
          method,
          hasSession,
          userAgent: `Mozilla/5.0 ${canary}`,
          headers: {
            "x-vercel-id": vercelId,
            "x-unrelated-metadata": canary,
            ...(incomingContext ? { "x-workos-session": "present" } : {}),
          },
          cookieValues: { unrelated: canary },
        }),
      );
      expect(response).toBe(mockNextResponseNext.mock.results[0]?.value);
      return mockNextResponseNext.mock.calls[0]?.[0] as {
        request: { headers: Headers };
      };
    }

    it.each([
      ["/", false],
      ["/download", true],
      ["/signup", false],
    ])(
      "records only bounded join fields for %s (session cookie=%s)",
      async (pathname, hasSession) => {
        const warning = jest
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        const oldBuild = process.env.VERCEL_GIT_COMMIT_SHA;
        process.env.VERCEL_GIT_COMMIT_SHA = "B".repeat(40);
        try {
          const init = await runPublicPage({ pathname, hasSession });
          // Pass-through request headers are unchanged by the receipt.
          expect(init.request.headers.get("x-workos-session")).toBe("present");
          expect(warning).toHaveBeenCalledTimes(1);
          const encoded = warning.mock.calls[0][0] as string;
          expect(encoded).not.toContain(canary);
          expect(JSON.parse(encoded)).toEqual({
            event: "public_page_auth_context_provenance",
            diagnostic_version: 1,
            boundary: "proxy",
            reason: "context_without_sdk_projection",
            pathname,
            request_method: "GET",
            had_session_cookie: hasSession,
            vercel_request_id: requestId,
            web_build_commit: "b".repeat(40),
          });
        } finally {
          warning.mockRestore();
          if (oldBuild === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
          else process.env.VERCEL_GIT_COMMIT_SHA = oldBuild;
        }
      },
    );

    it.each<[string, Parameters<typeof runPublicPage>[0]]>([
      ["SDK projected the context", { sdkContext: true }],
      ["no incoming context header", { incomingContext: false }],
      ["unjoinable request ID", { vercelId: `bad-${canary}` }],
      ["HEAD request", { method: "HEAD" }],
      ["other public path", { pathname: "/pricing" }],
    ])("does not record when %s", async (_label, options) => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await runPublicPage(options);
        expect(warning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    });

    it("preserves the pass-through response when logging throws", async () => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {
        throw new Error("logger unavailable");
      });
      try {
        const init = await runPublicPage({ pathname: "/signup" });
        expect(warning).toHaveBeenCalledTimes(1);
        expect(init.request.headers.get("x-workos-middleware")).toBe("true");
      } finally {
        warning.mockRestore();
      }
    });
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

  it.each(["throw", "callback"])(
    "returns signed-out 401 for terminal invalid refresh token through %s",
    async (mode) => {
      const error = {
        name: "TokenRefreshError",
        isTransient: false,
        cause: {
          status: 400,
          error: "invalid_grant",
          errorDescription: "Invalid refresh token.",
        },
      };
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        mockAuthkit.mockImplementation((_request, options: any) => {
          if (mode === "throw") return Promise.reject(error);
          options.onSessionRefreshError({ error: error.cause });
          return Promise.resolve({
            session: { user: null },
            headers: new Headers(),
            authorizationUrl: "https://auth.hackerai.co/login",
          });
        });
        const { default: proxy } = await import("../proxy");
        const response = await proxy(
          createRequest({
            pathname: "/",
            method: "POST",
            hasSession: true,
            headers: { "next-action": "auth-action" },
          }),
        );
        expect(response).toMatchObject({ kind: "json", init: { status: 401 } });
        expect(response.cookies.delete).toHaveBeenCalledWith("wos-session");
        expect(warn).toHaveBeenCalledWith(
          JSON.stringify({
            event: "auth.invalid_refresh_token",
            boundary: "proxy",
          }),
        );
        expect(mockNextResponseNext).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("does not convert transient refresh failures into signed-out recovery", async () => {
    const error = {
      name: "TokenRefreshError",
      isTransient: true,
      cause: {
        status: 400,
        error: "invalid_grant",
        errorDescription: "Invalid refresh token.",
      },
    };
    mockAuthkit.mockRejectedValue(error);
    const { default: proxy } = await import("../proxy");
    await expect(
      proxy(createRequest({ pathname: "/", hasSession: true })),
    ).rejects.toBe(error);
    expect(mockNextResponseNext).not.toHaveBeenCalled();
    expect(mockNextResponseJson).not.toHaveBeenCalled();
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

  describe("pending AuthKit warning", () => {
    const requestId = "iad1::fra1::abc12-1794282623256-a92d4497977c";
    const privateMarker = "private-pending-marker";
    const signedInAuthkit = {
      session: { user: { id: "user" } },
      headers: new Headers(),
    };

    /** An AuthKit call the test settles explicitly. */
    function deferredAuthkit() {
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      return { promise, resolve, reject };
    }

    /** Pass any phase, including values outside the typed set, to the proxy's observer. */
    function reportPhases(options: unknown, phases: unknown[]) {
      const observe = (options as AuthkitOptions).onSessionPhase as
        ((phase: unknown) => void) | undefined;
      for (const phase of phases) observe?.(phase);
    }

    function pendingWarnings(warning: { mock: { calls: unknown[][] } }) {
      return warning.mock.calls
        .map(([message]) => message)
        .filter(
          (message): message is string =>
            typeof message === "string" &&
            message.includes('"event":"proxy_authkit_pending"'),
        );
    }

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("warns once with the latest phase while a session-cookie AuthKit call is pending", async () => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
      const env = jest.replaceProperty(process, "env", {
        ...process.env,
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_SHA: "C".repeat(40),
      });
      const pending = deferredAuthkit();
      try {
        mockAuthkit.mockImplementationOnce(
          (_request: unknown, options: unknown) => {
            reportPhases(options, [
              "verify_access_token",
              "refresh_request",
              privateMarker,
            ]);
            return pending.promise;
          },
        );
        const { default: proxy } = await import("../proxy");
        const response = proxy(
          createRequest({
            pathname: `/c/${privateMarker}?secret=${privateMarker}`,
            method: "POST",
            accept: "text/html",
            userAgent: `Mozilla/5.0 ${privateMarker}`,
            hasSession: true,
            headers: {
              "x-vercel-id": requestId,
              authorization: privateMarker,
            },
            cookieValues: { unrelated: privateMarker },
          }),
        );

        await jest.advanceTimersByTimeAsync(9_999);
        expect(warning).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(warning).toHaveBeenCalledTimes(1);
        const encoded = warning.mock.calls[0][0] as string;
        expect(encoded).not.toContain(privateMarker);
        expect(JSON.parse(encoded)).toEqual({
          event: "proxy_authkit_pending",
          diagnostic_version: 1,
          boundary: "proxy",
          authkit_session_phase: "refresh_request",
          elapsed_ms: 10_000,
          warning_threshold_ms: 10_000,
          timer_lateness_ms: 0,
          request_method: "POST",
          route_kind: "chat_page",
          vercel_request_id: requestId,
          web_build_commit: "c".repeat(40),
          environment: "production",
        });

        await jest.advanceTimersByTimeAsync(60_000);
        pending.resolve(signedInAuthkit);
        const result = await response;
        expect(result).toBe(mockNextResponseNext.mock.results[0]?.value);
        expect(result).toMatchObject({ kind: "next" });
        expect(warning).toHaveBeenCalledTimes(1);
      } finally {
        env.restore();
        warning.mockRestore();
      }
    });

    it("reports an unobserved phase, drops malformed fields and keeps the AuthKit error", async () => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
      const env = jest.replaceProperty(process, "env", {
        ...process.env,
        VERCEL_ENV: privateMarker,
        VERCEL_GIT_COMMIT_SHA: privateMarker,
      });
      const pending = deferredAuthkit();
      const error = new Error("provider unavailable");
      try {
        mockAuthkit.mockImplementationOnce(
          (_request: unknown, options: unknown) => {
            reportPhases(options, [privateMarker, undefined]);
            return pending.promise;
          },
        );
        const { default: proxy } = await import("../proxy");
        const response = proxy(
          createRequest({
            pathname: `/api/${privateMarker}`,
            method: "PRIVATE-METHOD-MARKER",
            hasSession: true,
            headers: { "x-vercel-id": privateMarker },
          }),
        );

        await jest.advanceTimersByTimeAsync(10_000);
        const [encoded] = pendingWarnings(warning);
        expect(encoded).not.toContain(privateMarker);
        expect(encoded).not.toContain("PRIVATE-");
        expect(JSON.parse(encoded)).toEqual({
          event: "proxy_authkit_pending",
          diagnostic_version: 1,
          boundary: "proxy",
          authkit_session_phase: "not_observed",
          elapsed_ms: 10_000,
          warning_threshold_ms: 10_000,
          timer_lateness_ms: 0,
          request_method: "OTHER",
          route_kind: "api",
          environment: "unknown",
        });

        pending.reject(error);
        await expect(response).rejects.toBe(error);
        expect(mockAuthkit).toHaveBeenCalledTimes(1);
        expect(pendingWarnings(warning)).toHaveLength(1);
        expect(warning).toHaveBeenLastCalledWith(
          expect.stringContaining('"event":"proxy_authkit_failure_context"'),
        );
      } finally {
        env.restore();
        warning.mockRestore();
      }
    });

    it.each([
      {
        outcome: "signed-in result",
        settle: (call: ReturnType<typeof deferredAuthkit>) =>
          call.resolve(signedInAuthkit),
        expected: { kind: "next" },
      },
      {
        outcome: "ended-session rejection",
        settle: (call: ReturnType<typeof deferredAuthkit>) =>
          call.reject(
            Object.assign(new Error("invalid_grant"), {
              name: "TokenRefreshError",
              cause: {
                error: "invalid_grant",
                errorDescription: "Session has already ended.",
              },
            }),
          ),
        expected: { kind: "json", status: 401 },
      },
      {
        outcome: "unexpected rejection",
        settle: (call: ReturnType<typeof deferredAuthkit>) =>
          call.reject(new Error("provider unavailable")),
        expected: { error: "provider unavailable" },
      },
    ])(
      "does not warn after AuthKit settles before the threshold: $outcome",
      async ({ settle, expected }) => {
        const warning = jest
          .spyOn(console, "warn")
          .mockImplementation(() => {});
        const pending = deferredAuthkit();
        try {
          mockAuthkit.mockReturnValueOnce(pending.promise);
          const { default: proxy } = await import("../proxy");
          const response = proxy(
            createRequest({ pathname: "/api/example", hasSession: true }),
          ).then(
            (value) => value,
            (error: Error) => ({ error: error.message }),
          );

          await jest.advanceTimersByTimeAsync(9_999);
          settle(pending);
          expect(await response).toMatchObject(expected);
          await jest.advanceTimersByTimeAsync(60_000);
          expect(pendingWarnings(warning)).toEqual([]);
        } finally {
          warning.mockRestore();
        }
      },
    );

    it("does not time an anonymous AuthKit call", async () => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
      const pending = deferredAuthkit();
      try {
        mockAuthkit.mockReturnValueOnce(pending.promise);
        const { default: proxy } = await import("../proxy");
        const response = proxy(createRequest({ pathname: "/" }));

        await jest.advanceTimersByTimeAsync(60_000);
        expect(pendingWarnings(warning)).toEqual([]);
        pending.resolve({ session: { user: null }, headers: new Headers() });
        expect(await response).toMatchObject({ kind: "next" });
      } finally {
        warning.mockRestore();
      }
    });

    it("does not time a bypassed request", async () => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { default: proxy } = await import("../proxy");
        const response = await proxy(
          createRequest({ pathname: "/api/health/core", hasSession: true }),
        );
        await jest.advanceTimersByTimeAsync(60_000);
        expect(response).toMatchObject({ kind: "next" });
        expect(mockAuthkit).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    });

    it("does not time the anonymous retry after a malformed session cookie", async () => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
      const retry = deferredAuthkit();
      try {
        mockAuthkit
          .mockRejectedValueOnce(new Error("Wrong mac prefix"))
          .mockReturnValueOnce(retry.promise);
        const { default: proxy } = await import("../proxy");
        const response = proxy(
          createRequest({
            pathname: "/",
            accept: "text/html",
            cookieValues: { "wos-session": "bad*1*a*b*c*d*e*f" },
          }),
        );

        await jest.advanceTimersByTimeAsync(60_000);
        expect(mockAuthkit).toHaveBeenCalledTimes(2);
        expect(pendingWarnings(warning)).toEqual([]);
        retry.resolve({ session: { user: null }, headers: new Headers() });
        const result = await response;
        expect(result).toMatchObject({ kind: "next" });
        expect(result.cookies.delete).toHaveBeenCalledWith("wos-session");
      } finally {
        warning.mockRestore();
      }
    });

    it("preserves the AuthKit response when the pending warning logger throws", async () => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => {
        throw new Error("logger unavailable");
      });
      const pending = deferredAuthkit();
      const sessionCookie = "wos-session=refreshed; Path=/; HttpOnly";
      try {
        mockAuthkit.mockReturnValueOnce(pending.promise);
        const { default: proxy } = await import("../proxy");
        const response = proxy(
          createRequest({ pathname: "/api/example", hasSession: true }),
        );

        await jest.advanceTimersByTimeAsync(10_000);
        expect(warning).toHaveBeenCalledTimes(1);
        pending.resolve({
          session: { user: { id: "user" } },
          headers: new Headers({ "set-cookie": sessionCookie }),
        });
        const result = await response;
        expect(result).toBe(mockNextResponseNext.mock.results[0]?.value);
        const init = mockNextResponseNext.mock.calls[0]?.[0] as {
          headers: Headers;
        };
        expect(init.headers.get("set-cookie")).toBe(sessionCookie);
      } finally {
        warning.mockRestore();
      }
    });
  });
});
