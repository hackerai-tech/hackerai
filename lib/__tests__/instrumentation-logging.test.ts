const mockCaptureException = jest.fn();
jest.mock("@/app/posthog", () => ({
  __esModule: true,
  default: () => ({ captureException: mockCaptureException }),
}));

import { onRequestError } from "@/instrumentation";
import { flushPostHogLogs } from "@/lib/posthog/logs";

describe("request error diagnostic exports", () => {
  const originalFetch = global.fetch;
  const request = {
    path: "/auth/callback?code=SYNTHETIC_CODE&%74oken=SYNTHETIC_TOKEN#SYNTHETIC_FRAGMENT",
    method: "GET",
    headers: {},
  };
  const context = {
    routePath: "/auth/callback",
    routeType: "route" as const,
    routerKind: "App Router" as const,
    revalidateReason: undefined,
  };
  const endedSession = () =>
    new Error("invalid_grant: session has already ended");

  beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(process, "env", {
      ...process.env,
      POSTHOG_PROJECT_TOKEN: "synthetic-project-token",
      NEXT_PUBLIC_POSTHOG_KEY: "",
      POSTHOG_LOG_HOST: "http://127.0.0.1:9",
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    await flushPostHogLogs();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("omits query credentials from actual log exports and exception properties", async () => {
    onRequestError(new Error("request failed"), request, context);
    onRequestError(endedSession(), request, context);
    await flushPostHogLogs();

    const fetchMock = jest.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9/i/v1/logs");
    const body = String(options?.body);
    expect(body).not.toContain("SYNTHETIC_");
    const records = JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords;
    expect(
      records.map((record: { severityText: string }) => record.severityText),
    ).toEqual(["ERROR", "WARN"]);
    for (const record of records) {
      expect(record.attributes).toEqual(
        expect.arrayContaining([
          { key: "path", value: { stringValue: "/auth/callback" } },
          { key: "method", value: { stringValue: "GET" } },
        ]),
      );
    }
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][2].path).toBe("/auth/callback");
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(
      "SYNTHETIC_",
    );
  });

  it("omits query credentials from expected-auth console fallback", () => {
    process.env.POSTHOG_PROJECT_TOKEN = "";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    onRequestError(endedSession(), request, context);
    expect(warn).toHaveBeenCalledWith(
      "auth_session_refresh_ended",
      expect.objectContaining({
        path: "/auth/callback",
        method: "GET",
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SYNTHETIC_");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("exports root request correlation through the actual log sender and a content-free native receipt", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    onRequestError(
      Object.assign(new TypeError("root failed"), { digest: "1234567890" }),
      {
        path: "/?code=SYNTHETIC_CODE#SYNTHETIC_FRAGMENT",
        method: "GET",
        headers: {
          "x-vercel-id": "iad1::fixture-1794075870712-0123456789ab",
          cookie: "SYNTHETIC_COOKIE",
          authorization: "Bearer SYNTHETIC_TOKEN",
        },
      },
      {
        routePath: "/(chat)/page",
        routeType: "render",
        routerKind: "App Router",
        renderSource: "react-server-components",
        revalidateReason: undefined,
      },
    );
    await flushPostHogLogs();
    const body = String(jest.mocked(global.fetch).mock.calls[0][1]?.body);
    expect(body).not.toContain("SYNTHETIC_");
    const records = JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(1);
    expect(records[0].attributes).toEqual(
      expect.arrayContaining([
        {
          key: "root_request_error_diagnostic_version",
          value: { doubleValue: 1 },
        },
        {
          key: "vercel_request_id",
          value: { stringValue: "iad1::fixture-1794075870712-0123456789ab" },
        },
        {
          key: "root_render_source",
          value: { stringValue: "react-server-components" },
        },
        { key: "root_error_kind", value: { stringValue: "TypeError" } },
        { key: "error_digest", value: { stringValue: "1234567890" } },
      ]),
    );
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][2]).toMatchObject({
      vercel_request_id: "iad1::fixture-1794075870712-0123456789ab",
      root_request_error_diagnostic_version: 1,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/SYNTHETIC_|root failed/);
  });
  it.each(["GET", "POST"])(
    "exports shared-chat %s correlation without the share identifier through native and buffered logs",
    async (method) => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      onRequestError(
        Object.assign(new Error("shared page failed"), {
          digest: "1234567890",
          name: method === "POST" ? "TokenRefreshError" : "Error",
        }),
        {
          path: "/share/SYNTHETIC_SHARE_ID?code=SYNTHETIC_CODE#SYNTHETIC_FRAGMENT",
          method,
          headers: {
            "x-vercel-id": "iad1::fixture-1794075870712-0123456789ab",
            cookie: "SYNTHETIC_COOKIE",
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
      await flushPostHogLogs();
      const body = String(jest.mocked(global.fetch).mock.calls[0][1]?.body);
      expect(body).not.toContain("SYNTHETIC_");
      const records = JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords;
      expect(records).toHaveLength(1);
      expect(records[0].attributes).toEqual(
        expect.arrayContaining([
          { key: "path", value: { stringValue: "/share/[shareId]" } },
          {
            key: "root_request_error_diagnostic_version",
            value: { doubleValue: 1 },
          },
          { key: "error_digest", value: { stringValue: "1234567890" } },
          { key: "method", value: { stringValue: method } },
          {
            key: "root_error_kind",
            value: {
              stringValue: method === "POST" ? "TokenRefreshError" : "Error",
            },
          },
        ]),
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
        path: "/share/[shareId]",
        method,
        root_request_error_diagnostic_version: 1,
      });
      expect(String(warn.mock.calls[0][0])).not.toContain("SYNTHETIC_");
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException.mock.calls[0][2].path).toBe(
        "/share/[shareId]",
      );
    },
  );
});
