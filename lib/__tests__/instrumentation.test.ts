jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock("@/lib/posthog/logs", () => ({
  registerPostHogLogProvider: jest.fn(),
}));

jest.mock("@/lib/auth/expected-auth-errors", () => ({
  isEndedSessionRefreshError: jest.fn(() => false),
}));

import { phLogger } from "@/lib/posthog/server";
import { onRequestError } from "@/instrumentation";
import { isEndedSessionRefreshError } from "@/lib/auth/expected-auth-errors";

describe("root request error correlation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isEndedSessionRefreshError).mockReturnValue(false);
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["/?token=private-query", "GET", "render"],
    ["/login?code=private-query", "GET", "proxy"],
    ["/index#private-fragment", "HEAD", "route"],
  ] as const)(
    "correlates the actual %s %s failure at the %s boundary without exporting request contents",
    (path, method, routeType) => {
      const error = Object.assign(new TypeError("root failed"), {
        digest: "2147368089",
        cause: Object.assign(new Error("transport failed"), {
          code: "ECONNRESET",
          status: 503,
        }),
      });
      onRequestError(
        error,
        {
          path,
          method,
          headers: {
            "X-Vercel-Id": "cle1::iad1::fixture-1794075870712-0123456789ab",
            cookie: "private-cookie",
            authorization: "Bearer private-token",
          },
        },
        {
          routePath: "/(chat)/page",
          routeType,
          routerKind: "App Router",
          renderSource: "server-rendering",
          revalidateReason: undefined,
        },
      );
      expect(phLogger.error).toHaveBeenCalledTimes(1);
      expect(phLogger.error).toHaveBeenCalledWith(
        "Next.js request error",
        expect.objectContaining({
          error,
          path: path.split(/[?#]/, 1)[0],
          routeType,
          root_request_error_diagnostic_version: 1,
          vercel_request_id: "cle1::iad1::fixture-1794075870712-0123456789ab",
          error_digest: "2147368089",
          root_error_kind: "TypeError",
          root_error_status: null,
          root_error_code: "none",
          root_cause_kind: "Error",
          root_cause_status: 503,
          root_cause_code: "ECONNRESET",
          root_render_source: "server-rendering",
        }),
      );
      expect(console.warn).toHaveBeenCalledTimes(1);
      const receipt = JSON.parse(jest.mocked(console.warn).mock.calls[0][0]);
      expect(receipt).toMatchObject({
        event: "root_request_error_context",
        path: path.split(/[?#]/, 1)[0],
        method,
        route_type: routeType,
        root_request_error_diagnostic_version: 1,
      });
      expect(
        Object.values(receipt).every(
          (value) =>
            value === null ||
            ["string", "number", "boolean"].includes(typeof value),
        ),
      ).toBe(true);
      expect(JSON.stringify(receipt)).not.toMatch(
        /private-|root failed|transport failed/,
      );
    },
  );

  it.each([
    ["GET", "Error"],
    ["HEAD", "Error"],
    ["POST", "TokenRefreshError"],
  ])(
    "correlates shared-chat %s failures with a normalized path",
    (method, errorKind) => {
      const error = Object.assign(new Error("shared render failed"), {
        name: errorKind,
        digest: "2147368089",
        cause: Object.assign(new TypeError("private transport detail"), {
          code: "ETIMEDOUT",
          status: 504,
        }),
      });
      onRequestError(
        error,
        {
          path: "/share/private-share-id/?token=private-token#private-fragment",
          method,
          headers: {
            "x-vercel-id": "iad1::fixture-1794075870712-0123456789ab",
            cookie: "private-cookie",
          },
        },
        {
          routePath: "/share/[shareId]/page",
          routeType: method === "POST" ? "action" : "render",
          routerKind: "App Router",
          renderSource: "react-server-components",
          revalidateReason: undefined,
        },
      );
      expect(console.warn).toHaveBeenCalledTimes(1);
      const receipt = JSON.parse(jest.mocked(console.warn).mock.calls[0][0]);
      expect(receipt).toMatchObject({
        event: "root_request_error_context",
        path: "/share/[shareId]",
        method,
        root_request_error_diagnostic_version: 1,
        root_error_kind: errorKind,
        root_cause_kind: "TypeError",
        root_cause_status: 504,
        root_cause_code: "ETIMEDOUT",
        root_render_source: "react-server-components",
        error_digest: "2147368089",
        vercel_request_id: "iad1::fixture-1794075870712-0123456789ab",
      });
      expect(JSON.stringify(receipt)).not.toContain("private");
      expect(phLogger.error).toHaveBeenCalledTimes(1);
      expect(phLogger.error).toHaveBeenCalledWith(
        "Next.js request error",
        expect.objectContaining({ error, path: "/share/[shareId]" }),
      );
    },
  );

  it.each([
    ["/api/chat", "GET", false],
    ["/share/item/nested", "GET", false],
    ["/share/item", "PUT", false],
    ["/share/item/nested", "POST", false],
    ["/api/chat", "POST", false],
    ["/login", "POST", false],
    ["/share/item", "POST", true],
    ["/", "POST", false],
    ["/login", "GET", true],
  ] as const)(
    "does not add a receipt outside unexpected root reads (%s,%s,expected=%s)",
    (path, method, expected) => {
      jest.mocked(isEndedSessionRefreshError).mockReturnValue(expected);
      onRequestError(
        new Error("unchanged"),
        { path, method, headers: {} },
        {
          routePath: path,
          routeType: "render",
          routerKind: "App Router",
          revalidateReason: undefined,
        },
      );
      expect(console.warn).not.toHaveBeenCalled();
      const logger = expected ? phLogger.warn : phLogger.error;
      expect(logger).toHaveBeenCalledTimes(1);
      expect(jest.mocked(logger).mock.calls[0][1]).not.toHaveProperty(
        "root_request_error_diagnostic_version",
      );
    },
  );

  it("omits malformed IDs and untrusted digest strings and bounds throwing error accessors", () => {
    const error = Object.defineProperty(new Error("private-message"), "name", {
      get: () => {
        throw new Error("private-getter");
      },
    });
    Object.defineProperty(error, "digest", {
      get: () => {
        throw new Error("private-digest");
      },
    });
    expect(() =>
      onRequestError(
        error,
        {
          path: "/",
          method: "GET",
          headers: { "x-vercel-id": "private invalid header" },
        },
        {
          routePath: "/",
          routeType: "render",
          routerKind: "App Router",
          revalidateReason: undefined,
        },
      ),
    ).not.toThrow();
    const receipt = JSON.parse(jest.mocked(console.warn).mock.calls[0][0]);
    expect(receipt).toMatchObject({
      root_error_kind: "unreadable_error",
      root_render_source: "unknown",
    });
    expect(receipt).not.toHaveProperty("vercel_request_id");
    expect(receipt).not.toHaveProperty("error_digest");
    expect(JSON.stringify(receipt)).not.toContain("private");
  });

  it("keeps the original error report when the optional native receipt fails", () => {
    jest.mocked(console.warn).mockImplementation(() => {
      throw new Error("console unavailable");
    });
    const error = new Error("original failure");
    expect(() =>
      onRequestError(
        error,
        { path: "/", method: "GET", headers: {} },
        {
          routePath: "/",
          routeType: "render",
          routerKind: "App Router",
          revalidateReason: undefined,
        },
      ),
    ).not.toThrow();
    expect(phLogger.error).toHaveBeenCalledWith(
      "Next.js request error",
      expect.objectContaining({ error }),
    );
  });

  it("exports only the closed taxonomy when error metadata contains private strings", () => {
    const error = Object.assign(new Error("private-message"), {
      name: "private-name",
      code: "private-code",
      status: "private-status",
      digest: "private-digest",
      cause: { name: "private-cause", code: "private-cause-code" },
    });
    onRequestError(
      error,
      { path: "/", method: "GET", headers: { "x-vercel-id": "privateToken" } },
      {
        routePath: "/",
        routeType: "render",
        routerKind: "App Router",
        revalidateReason: undefined,
      },
    );
    const receipt = JSON.parse(jest.mocked(console.warn).mock.calls[0][0]);
    expect(receipt).toMatchObject({
      root_error_kind: "other_error",
      root_error_status: null,
      root_error_status_shape: "non_numeric",
      root_error_code: "other",
      root_cause_kind: "other_error",
      root_cause_code: "other",
    });
    expect(receipt).not.toHaveProperty("vercel_request_id");
    expect(receipt).not.toHaveProperty("error_digest");
    expect(JSON.stringify(receipt)).not.toContain("private");
    const allowed = new Set([
      "timestamp",
      "level",
      "event",
      "service",
      "environment",
      "web_build_commit",
      "path",
      "method",
      "route_type",
      "root_request_error_diagnostic_version",
      "root_error_kind",
      "root_error_status",
      "root_error_status_shape",
      "root_error_code",
      "root_cause_kind",
      "root_cause_status",
      "root_cause_status_shape",
      "root_cause_code",
      "root_render_source",
      "vercel_request_id",
      "error_digest",
    ]);
    expect(Object.keys(receipt).every((key) => allowed.has(key))).toBe(true);
  });
});

describe("desktop authorization request error correlation", () => {
  const DESKTOP_PATH = "/api/desktop/authorized-operation";
  const OPERATION_ID = "0d".repeat(32);
  const OPERATION_DIGEST = "d1".repeat(32);
  const routeContext: Parameters<typeof onRequestError>[2] = {
    routePath: "/api/desktop/authorized-operation/route",
    routeType: "route",
    routerKind: "App Router",
    revalidateReason: undefined,
  };
  const failedRedemption = () =>
    Object.assign(new TypeError(`private-redeem ${OPERATION_ID}`), {
      digest: "2147368089",
      cause: Object.assign(new Error(`private-store ${OPERATION_DIGEST}`), {
        code: "ECONNRESET",
        status: 503,
      }),
    });
  const desktopRequest = (method = "POST", path = DESKTOP_PATH) => ({
    path: `${path}?id=${OPERATION_ID}#private-fragment`,
    method,
    headers: {
      "x-vercel-id": "iad1::fixture-1794424380724-0123456789ab",
      cookie: "private-cookie",
      authorization: "Bearer private-token",
      "content-type": "application/json",
      "content-length": "142",
    },
  });
  // Contract tuple for this request; Next's thrown status is not an HTTP status.
  const expectedTuple = {
    root_request_error_diagnostic_version: 1,
    root_error_kind: "TypeError",
    root_error_status: null,
    root_error_status_shape: "absent",
    root_error_code: "none",
    root_cause_kind: "Error",
    root_cause_status: 503,
    root_cause_status_shape: "integer",
    root_cause_code: "ECONNRESET",
    root_render_source: "unknown",
    vercel_request_id: "iad1::fixture-1794424380724-0123456789ab",
    error_digest: "2147368089",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isEndedSessionRefreshError).mockReturnValue(false);
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.replaceProperty(process, "env", {
      ...process.env,
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it("emits one finite native receipt and augments the existing export for the exact POST", () => {
    const error = failedRedemption();
    onRequestError(error, desktopRequest(), routeContext);

    expect(console.warn).toHaveBeenCalledTimes(1);
    const line = jest.mocked(console.warn).mock.calls[0][0];
    expect(JSON.parse(line)).toStrictEqual({
      timestamp: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
      level: "warn",
      event: "root_request_error_context",
      service: "hackerai-web",
      environment: "production",
      web_build_commit: "0123456789abcdef0123456789abcdef01234567",
      path: DESKTOP_PATH,
      method: "POST",
      route_type: "route",
      ...expectedTuple,
    });
    expect(line).not.toMatch(
      new RegExp(`private|${OPERATION_ID}|${OPERATION_DIGEST}`),
    );

    expect(phLogger.error).toHaveBeenCalledTimes(1);
    expect(phLogger.error).toHaveBeenCalledWith("Next.js request error", {
      error,
      path: DESKTOP_PATH,
      method: "POST",
      routePath: "/api/desktop/authorized-operation/route",
      routeType: "route",
      routerKind: "App Router",
      ...expectedTuple,
    });
  });

  it.each<[string, string, string, Parameters<typeof onRequestError>[2]]>([
    ["wrong method", "GET", DESKTOP_PATH, routeContext],
    ["wrong method", "HEAD", DESKTOP_PATH, routeContext],
    ["wrong method", "PUT", DESKTOP_PATH, routeContext],
    ["wrong method", "post", DESKTOP_PATH, routeContext],
    ["trailing slash", "POST", `${DESKTOP_PATH}/`, routeContext],
    ["nested path", "POST", `${DESKTOP_PATH}/nested`, routeContext],
    ["lookalike", "POST", `${DESKTOP_PATH}s`, routeContext],
    ["lookalike", "POST", `${DESKTOP_PATH}.json`, routeContext],
    ["lookalike", "POST", "/API/desktop/authorized-operation", routeContext],
    ["prefixed", "POST", `/x${DESKTOP_PATH}`, routeContext],
    ["parent", "POST", "/api/desktop", routeContext],
    ["other API", "POST", "/api/chat", routeContext],
    [
      "Pages Router",
      "POST",
      DESKTOP_PATH,
      { ...routeContext, routerKind: "Pages Router" },
    ],
    ["action", "POST", DESKTOP_PATH, { ...routeContext, routeType: "action" }],
    ["render", "POST", DESKTOP_PATH, { ...routeContext, routeType: "render" }],
    ["proxy", "POST", DESKTOP_PATH, { ...routeContext, routeType: "proxy" }],
  ])(
    "does not open the receipt for a %s (%s %s)",
    (_case, method, path, context) => {
      const error = failedRedemption();
      onRequestError(error, desktopRequest(method, path), context);

      expect(console.warn).not.toHaveBeenCalled();
      expect(phLogger.error).toHaveBeenCalledTimes(1);
      const payload = jest.mocked(phLogger.error).mock.calls[0][1] ?? {};
      expect(payload.error).toBe(error);
      expect(
        Object.keys(payload).filter((key) => key.startsWith("root_")),
      ).toEqual([]);
    },
  );

  it("keeps the expected-auth early return for the exact POST", () => {
    jest.mocked(isEndedSessionRefreshError).mockReturnValue(true);
    onRequestError(failedRedemption(), desktopRequest(), routeContext);

    expect(console.warn).not.toHaveBeenCalled();
    expect(phLogger.error).not.toHaveBeenCalled();
    expect(phLogger.warn).toHaveBeenCalledTimes(1);
    expect(jest.mocked(phLogger.warn).mock.calls[0][1]).not.toHaveProperty(
      "root_request_error_diagnostic_version",
    );
  });

  it("bounds a hostile error and still exports the original value", () => {
    const fail = () => {
      throw new Error("private-accessor");
    };
    const hostile = new Proxy(new Error("private-message"), {
      get: fail,
      has: fail,
      ownKeys: fail,
      getOwnPropertyDescriptor: fail,
      getPrototypeOf: fail,
    });
    expect(() =>
      onRequestError(hostile, desktopRequest(), routeContext),
    ).not.toThrow();

    const line = jest.mocked(console.warn).mock.calls[0][0];
    expect(JSON.parse(line)).toMatchObject({
      path: DESKTOP_PATH,
      root_error_kind: "unreadable_error",
      root_cause_kind: "unreadable_error",
      vercel_request_id: expectedTuple.vercel_request_id,
    });
    expect(JSON.parse(line)).not.toHaveProperty("error_digest");
    expect(line).not.toContain("private");
    expect(phLogger.error).toHaveBeenCalledTimes(1);
    const payload = jest.mocked(phLogger.error).mock.calls[0][1] ?? {};
    expect(payload.error).toBe(hostile);
    expect(payload.root_request_error_diagnostic_version).toBe(1);
  });

  it("keeps the original error export when the native receipt sink throws", () => {
    jest.mocked(console.warn).mockImplementation(() => {
      throw new Error("console unavailable");
    });
    const error = failedRedemption();
    expect(() =>
      onRequestError(error, desktopRequest(), routeContext),
    ).not.toThrow();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(phLogger.error).toHaveBeenCalledTimes(1);
    expect(phLogger.error).toHaveBeenCalledWith(
      "Next.js request error",
      expect.objectContaining({ error, path: DESKTOP_PATH, ...expectedTuple }),
    );
  });
});

describe("onRequestError", () => {
  const mockPhLoggerError = phLogger.error as jest.MockedFunction<
    typeof phLogger.error
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isEndedSessionRefreshError).mockReturnValue(false);
  });

  describe.each([false, true])(
    "expected auth error: %s",
    (expectedAuthError) => {
      it.each([
        [
          "/auth/callback?code=oauth-secret&access_token=token-secret",
          "/auth/callback",
        ],
        ["/api/chat?%74oken=encoded-secret&custom=private-value", "/api/chat"],
        ["/auth/callback#fragment-secret?code=oauth-secret", "/auth/callback"],
        [
          "https://example.test/auth/callback?state=state-secret",
          "https://example.test/auth/callback",
        ],
        ["/c/%3F%23opaque?code=oauth-secret", "/c/%3F%23opaque"],
        ["/c/opaque-chat-id", "/c/opaque-chat-id"],
        ["/invalid%path?code=oauth-secret", "/invalid%path"],
      ])(
        "keeps query and fragment out of request diagnostics for %s",
        (path, safePath) => {
          jest
            .mocked(isEndedSessionRefreshError)
            .mockReturnValue(expectedAuthError);
          const error = new Error("request failed");
          const request = { path, method: "GET", headers: {} };
          onRequestError(error, request, {
            routePath: "/auth/callback",
            routeType: "route",
            routerKind: "App Router",
            revalidateReason: undefined,
          });

          const logger = expectedAuthError ? phLogger.warn : phLogger.error;
          expect(logger).toHaveBeenCalledWith(
            expectedAuthError
              ? "auth_session_refresh_ended"
              : "Next.js request error",
            expect.objectContaining({
              error,
              path: safePath,
              method: "GET",
              routePath: "/auth/callback",
              routeType: "route",
              routerKind: "App Router",
            }),
          );
          expect(
            expectedAuthError ? phLogger.error : phLogger.warn,
          ).not.toHaveBeenCalled();
          expect(request.path).toBe(path);
        },
      );
    },
  );

  it("adds bounded Server Action request metadata without sensitive headers", () => {
    const error = Object.assign(
      new SyntaxError("Unexpected end of JSON input"),
      {
        digest: "2147368089",
      },
    );

    onRequestError(
      error,
      {
        path: "/c/opaque-chat-id",
        method: "POST",
        headers: {
          "next-action": "a".repeat(40),
          "content-type": "text/plain; charset=utf-8",
          "content-length": "0",
          "x-vercel-id": "iad1::opaque-request",
          authorization: "Bearer secret",
          cookie: "session=secret",
        },
      },
      {
        routePath: "/c/[id]",
        routeType: "action",
        routerKind: "App Router",
        revalidateReason: undefined,
      },
    );

    expect(mockPhLoggerError).toHaveBeenCalledWith(
      "Next.js request error",
      expect.objectContaining({
        error,
        routeType: "action",
        action_id: "a".repeat(40),
        content_type: "text/plain",
        content_length: 0,
        vercel_request_id: "iad1::opaque-request",
        error_digest: "2147368089",
      }),
    );
    const logged = JSON.stringify(mockPhLoggerError.mock.calls[0][1]);
    expect(logged).not.toContain("Bearer secret");
    expect(logged).not.toContain("session=secret");
  });

  it("omits malformed Server Action metadata", () => {
    onRequestError(
      new Error("boom"),
      {
        path: "/api/chat",
        method: "POST",
        headers: {
          "next-action": "not-an-action-id",
          "content-length": "NaN",
          "x-vercel-id": "not valid whitespace",
        },
      },
      {
        routePath: "/c/[id]",
        routeType: "action",
        routerKind: "App Router",
        revalidateReason: undefined,
      },
    );

    const payload = mockPhLoggerError.mock.calls[0][1];
    expect(payload).not.toHaveProperty("action_id");
    expect(payload).not.toHaveProperty("content_length");
    expect(payload).not.toHaveProperty("vercel_request_id");
    expect(payload).not.toHaveProperty("error_digest");
  });

  it("leaves non-action request logging unchanged", () => {
    onRequestError(
      new Error("boom"),
      {
        path: "/api/chat",
        method: "POST",
        headers: {
          "next-action": "a".repeat(40),
          "content-length": "123",
          "x-vercel-id": "iad1::opaque-request",
        },
      },
      {
        routePath: "/api/chat",
        routeType: "route",
        routerKind: "App Router",
        revalidateReason: undefined,
      },
    );

    const payload = mockPhLoggerError.mock.calls[0][1];
    expect(payload).not.toHaveProperty("action_id");
    expect(payload).not.toHaveProperty("content_length");
    expect(payload).not.toHaveProperty("vercel_request_id");
    expect(payload).not.toHaveProperty("error_digest");
  });
});
