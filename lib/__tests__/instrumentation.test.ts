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
    ["/index", "POST", false],
    ["/", "POST", true],
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

describe("core POST request error correlation", () => {
  const CHAT_ID = "SYNTHETIC-CHAT-0f3c2a91";
  const appAction = {
    routePath: "/(chat)/c/[id]/page",
    routeType: "action",
    routerKind: "App Router",
    renderSource: "react-server-components",
    revalidateReason: undefined,
  } as const;
  const appRender = { ...appAction, routeType: "render" } as const;
  const appRoute = {
    routePath: "/api/agent/status/route",
    routeType: "route",
    routerKind: "App Router",
    revalidateReason: undefined,
  } as const;
  // Next's proxy template reports every proxy throw this way, including for
  // requests that target App Router pages and APIs.
  const pagesProxy = {
    routePath: "/proxy",
    routeType: "proxy",
    routerKind: "Pages Router",
    revalidateReason: undefined,
  } as const;
  const failure = () =>
    Object.assign(new TypeError(`private-failure ${CHAT_ID}`), {
      digest: "2147368089",
      cause: Object.assign(new Error(`private-cause ${CHAT_ID}`), {
        code: "ECONNRESET",
        status: 503,
      }),
    });
  const postRequest = (path: string, method = "POST") => ({
    path: `${path}?chatId=${CHAT_ID}&token=private-query#private-fragment`,
    method,
    headers: {
      "x-vercel-id": "iad1::fixture-1794426146963-b68e429d9b2f",
      cookie: "private-cookie",
      authorization: "Bearer private-token",
    },
  });
  const tuple = {
    root_request_error_diagnostic_version: 1,
    root_error_kind: "TypeError",
    root_error_status: null,
    root_error_status_shape: "absent",
    root_error_code: "none",
    root_cause_kind: "Error",
    root_cause_status: 503,
    root_cause_status_shape: "integer",
    root_cause_code: "ECONNRESET",
    vercel_request_id: "iad1::fixture-1794426146963-b68e429d9b2f",
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

  it.each<[string, string, Parameters<typeof onRequestError>[2]]>([
    ["/", "/", appAction],
    ["/", "/", appRender],
    ["/", "/", pagesProxy],
    [`/c/${CHAT_ID}`, "/c/[id]", appAction],
    [`/c/${CHAT_ID}`, "/c/[id]", appRender],
    [`/c/${CHAT_ID}`, "/c/[id]", pagesProxy],
    [`/c/${CHAT_ID}/`, "/c/[id]", appAction],
    ["/api/agent/status", "/api/agent/status", appRoute],
    ["/api/agent/status", "/api/agent/status", pagesProxy],
  ])(
    "emits one receipt for POST %s as %s without request contents",
    (path, safePath, context) => {
      const error = failure();
      onRequestError(error, postRequest(path), context);

      expect(console.warn).toHaveBeenCalledTimes(1);
      const line = jest.mocked(console.warn).mock.calls[0][0];
      expect(JSON.parse(line)).toStrictEqual({
        timestamp: expect.any(String),
        level: "warn",
        event: "root_request_error_context",
        service: "hackerai-web",
        environment: "production",
        web_build_commit: "0123456789abcdef0123456789abcdef01234567",
        path: safePath,
        method: "POST",
        route_type: context.routeType,
        ...tuple,
        root_render_source: context.renderSource ?? "unknown",
      });
      expect(line).not.toMatch(/private|SYNTHETIC/);

      expect(phLogger.error).toHaveBeenCalledTimes(1);
      const [message, payload] = jest.mocked(phLogger.error).mock.calls[0];
      expect(message).toBe("Next.js request error");
      expect(payload?.error).toBe(error);
      expect(payload).toMatchObject({
        path: safePath,
        method: "POST",
        routePath: context.routePath,
        ...tuple,
      });
      const { error: _original, ...properties } = payload ?? {};
      expect(JSON.stringify(properties)).not.toMatch(/private|SYNTHETIC/);
    },
  );

  it.each<[string, string, string, Parameters<typeof onRequestError>[2]]>([
    ["status read", "GET", "/api/agent/status", appRoute],
    ["status read", "GET", "/api/agent/status", pagesProxy],
    ["root method", "PUT", "/", appAction],
    ["chat method", "DELETE", `/c/${CHAT_ID}`, pagesProxy],
    ["lowercase method", "post", `/c/${CHAT_ID}`, appAction],
    ["deeper chat", "POST", `/c/${CHAT_ID}/nested`, appAction],
    ["chat lookalike", "POST", "/c", appAction],
    ["chat lookalike", "POST", "/c/", appAction],
    ["chat lookalike", "POST", "/C/opaque", appAction],
    ["chat lookalike", "POST", "/chat/opaque", appAction],
    ["chat lookalike", "POST", "/x/c/opaque", appAction],
    ["status lookalike", "POST", "/api/agent/status/", appRoute],
    ["status lookalike", "POST", "/api/agent/statuses", appRoute],
    ["status lookalike", "POST", "/api/agent/status.json", appRoute],
    ["status parent", "POST", "/api/agent", appRoute],
    ["other API", "POST", "/api/chat", appRoute],
    ["other API", "POST", "/api/chat", pagesProxy],
    ["index", "POST", "/index", appAction],
    ["root route", "POST", "/", appRoute],
    ["chat route", "POST", `/c/${CHAT_ID}`, appRoute],
    ["status action", "POST", "/api/agent/status", appAction],
    ["status render", "POST", "/api/agent/status", appRender],
    [
      "App Router proxy",
      "POST",
      "/",
      { ...pagesProxy, routerKind: "App Router" },
    ],
    [
      "Pages Router render",
      "POST",
      `/c/${CHAT_ID}`,
      { ...appRender, routerKind: "Pages Router" },
    ],
    [
      "Pages Router route",
      "POST",
      "/api/agent/status",
      { ...appRoute, routerKind: "Pages Router" },
    ],
    [
      "unknown router",
      "POST",
      "/",
      {
        ...appAction,
        routerKind: "Other Router" as unknown as "App Router",
      },
    ],
  ])(
    "does not open the receipt for a %s (%s %s)",
    (_case, method, path, context) => {
      const error = failure();
      onRequestError(error, postRequest(path, method), context);

      expect(console.warn).not.toHaveBeenCalled();
      expect(phLogger.error).toHaveBeenCalledTimes(1);
      const payload = jest.mocked(phLogger.error).mock.calls[0][1] ?? {};
      expect(payload.error).toBe(error);
      expect(
        Object.keys(payload).filter((key) => key.startsWith("root_")),
      ).toEqual([]);
    },
  );

  it("keeps the expected-auth early return and normalizes its chat path", () => {
    jest.mocked(isEndedSessionRefreshError).mockReturnValue(true);
    const error = failure();
    onRequestError(error, postRequest(`/c/${CHAT_ID}`), appAction);

    expect(console.warn).not.toHaveBeenCalled();
    expect(phLogger.error).not.toHaveBeenCalled();
    expect(phLogger.warn).toHaveBeenCalledTimes(1);
    const payload = jest.mocked(phLogger.warn).mock.calls[0][1] ?? {};
    expect(payload.error).toBe(error);
    expect(payload.path).toBe("/c/[id]");
    expect(payload).not.toHaveProperty("root_request_error_diagnostic_version");
    const { error: _original, ...properties } = payload;
    expect(JSON.stringify(properties)).not.toMatch(/private|SYNTHETIC/);
  });

  it("omits malformed request IDs, digests and builds on a status POST", () => {
    jest.replaceProperty(process, "env", {
      ...process.env,
      VERCEL_ENV: "private-environment",
      VERCEL_GIT_COMMIT_SHA: `private-${CHAT_ID}`,
    });
    const error = Object.assign(new Error("private-message"), {
      digest: `private-${CHAT_ID}`,
    });
    onRequestError(
      error,
      {
        path: "/api/agent/status",
        method: "POST",
        headers: { "x-vercel-id": `iad1::${CHAT_ID}` },
      },
      appRoute,
    );

    const line = jest.mocked(console.warn).mock.calls[0][0];
    const receipt = JSON.parse(line);
    expect(receipt).toMatchObject({
      environment: "unknown",
      path: "/api/agent/status",
      root_error_kind: "Error",
    });
    expect(receipt).not.toHaveProperty("web_build_commit");
    expect(receipt).not.toHaveProperty("vercel_request_id");
    expect(receipt).not.toHaveProperty("error_digest");
    expect(line).not.toMatch(/private|SYNTHETIC/);
    const payload = jest.mocked(phLogger.error).mock.calls[0][1] ?? {};
    expect(payload.error).toBe(error);
    expect(payload).not.toHaveProperty("vercel_request_id");
    expect(payload).not.toHaveProperty("error_digest");
  });

  it("bounds a hostile error on a chat POST proxy failure and still exports it", () => {
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
      onRequestError(hostile, postRequest(`/c/${CHAT_ID}`), pagesProxy),
    ).not.toThrow();

    const line = jest.mocked(console.warn).mock.calls[0][0];
    expect(JSON.parse(line)).toMatchObject({
      path: "/c/[id]",
      route_type: "proxy",
      root_error_kind: "unreadable_error",
      root_cause_kind: "unreadable_error",
      vercel_request_id: tuple.vercel_request_id,
    });
    expect(JSON.parse(line)).not.toHaveProperty("error_digest");
    expect(line).not.toMatch(/private|SYNTHETIC/);
    expect(phLogger.error).toHaveBeenCalledTimes(1);
    const payload = jest.mocked(phLogger.error).mock.calls[0][1] ?? {};
    expect(payload.error).toBe(hostile);
    expect(payload.path).toBe("/c/[id]");
  });

  it("keeps the original root POST report when the native receipt sink throws", () => {
    jest.mocked(console.warn).mockImplementation(() => {
      throw new Error("console unavailable");
    });
    const error = failure();
    expect(() =>
      onRequestError(error, postRequest("/"), appAction),
    ).not.toThrow();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(phLogger.error).toHaveBeenCalledTimes(1);
    expect(phLogger.error).toHaveBeenCalledWith(
      "Next.js request error",
      expect.objectContaining({ error, path: "/", ...tuple }),
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
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

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
        ["/c/%3F%23opaque?code=oauth-secret", "/c/[id]"],
        ["/c/opaque-chat-id", "/c/[id]"],
        ["/c/opaque-chat-id/#fragment-secret", "/c/[id]"],
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
        path: "/c/[id]",
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
    expect(logged).not.toContain("opaque-chat-id");
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
