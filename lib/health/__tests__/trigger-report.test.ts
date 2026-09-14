import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockFetch = jest.fn<typeof fetch>();
const originalFetch = global.fetch;
const originalEnv = process.env;
const NOW = new Date("2026-09-14T12:00:00.000Z");

// The consumed subset of Trigger's ReportViewModel JSON contract.
const report = () => ({
  title: "health",
  scope: "prod",
  period: "last 1h",
  generatedAt: NOW.toISOString(),
  windowMinutes: 60,
  summary: { severity: "ok" },
  findings: [
    { type: "flow", severity: "ok", reason: "healthy", metricIds: [] },
    { type: "execution", severity: "ok", reason: "healthy", metricIds: [] },
    { type: "liveness", severity: "ok", reason: "fresh", metricIds: [] },
  ],
  facts: { trustworthy: true, privateData: "must-not-leak" },
  metrics: [{ privateData: "must-not-leak" }],
});
const respond = (body: unknown = report(), status = 200) =>
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);

async function check() {
  const { getReport } = await import("../trigger-report");
  const { getTriggerHealthConfig } = await import("../config");
  const config = getTriggerHealthConfig();
  const body = config
    ? await getReport(config)
    : { status: "unknown", error: "trigger_report_not_configured" };
  return {
    response: {
      status:
        body.status === "healthy" || body.status === "degraded" ? 200 : 503,
    },
    body,
  };
}

describe("Trigger health report", () => {
  let infoSpy: jest.SpiedFunction<typeof console.info>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockReset();
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    process.env = { ...originalEnv, TRIGGER_SECRET_KEY: "test-key" };
    for (const name of [
      "TRIGGER_API_URL",
      "TRIGGER_ACCESS_TOKEN",
      "TRIGGER_PREVIEW_BRANCH",
      "VERCEL_GIT_COMMIT_REF",
      "TRIGGER_DEV_BRANCH",
    ])
      delete process.env[name];
    global.fetch = mockFetch;
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("uses authenticated reports and exposes only the health summary", async () => {
    respond();
    const { response, body } = await check();
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      new URL(
        "https://api.trigger.dev/api/v1/reports/health?period=1h&format=json",
      ),
      expect.objectContaining({
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: {
          accept: "application/json",
          authorization: "Bearer test-key",
        },
      }),
    );
    expect(body).toEqual({
      status: "healthy",
      generatedAt: NOW.toISOString(),
      dimensions: {
        flow: "healthy",
        execution: "healthy",
        liveness: "healthy",
      },
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it.each(["flow", "execution", "liveness"])(
    "reports degraded %s without declaring an outage",
    async (dimension) => {
      const payload = report();
      payload.findings.find((f) => f.type === dimension)!.severity = "warn";
      payload.summary.severity = "warn";
      respond(payload);
      const { response, body } = await check();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: "degraded",
        dimensions: { [dimension]: "degraded" },
      });
    },
  );

  it.each(["flow", "execution", "liveness"])(
    "returns 503 for failing %s even if the summary disagrees",
    async (dimension) => {
      const payload = report();
      payload.findings.find((f) => f.type === dimension)!.severity = "crit";
      respond(payload);
      const { response, body } = await check();
      expect(response.status).toBe(503);
      expect(body).toMatchObject({ status: "failing" });
    },
  );

  it("honors a critical summary", async () => {
    const payload = report();
    payload.summary.severity = "crit";
    respond(payload);
    expect((await check()).body.status).toBe("failing");
  });

  it("does not mistake untrustworthy telemetry for health", async () => {
    const payload = report();
    payload.facts.trustworthy = false;
    respond(payload);
    const { response, body } = await check();
    expect(response.status).toBe(503);
    expect(body.status).toBe("unknown");
  });

  it.each(["unknown", "freshness_unknown", "flow_unmeasured"])(
    "keeps %s distinct from healthy",
    async (reason) => {
      const payload = report();
      payload.findings[0].reason = reason;
      respond(payload);
      expect((await check()).body.status).toBe("unknown");
    },
  );

  it.each([
    null,
    {},
    { ...report(), title: "cost" },
    { ...report(), generatedAt: "invalid" },
    { ...report(), facts: {} },
    { ...report(), windowMinutes: 1440 },
    { ...report(), summary: { severity: "healthy" } },
    { ...report(), findings: report().findings.slice(1) },
    { ...report(), findings: [...report().findings, report().findings[0]] },
  ])("rejects malformed or incomplete reports (%#)", async (payload) => {
    respond(payload);
    const { response, body } = await check();
    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "unknown",
      error: "trigger_report_invalid",
    });
  });

  it.each([-300_001, 31_000])(
    "rejects stale or future-dated reports (%i ms)",
    async (offset) => {
      respond({
        ...report(),
        generatedAt: new Date(NOW.getTime() + offset).toISOString(),
      });
      expect((await check()).body.error).toBe("trigger_report_stale");
    },
  );

  it.each([401, 403, 404, 429, 500])(
    "returns unknown when upstream returns %i",
    async (status) => {
      respond({ secret: "must-not-leak" }, status);
      const { response, body } = await check();
      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        status: "unknown",
        error: "trigger_report_unavailable",
        sourceStatus: status,
      });
      expect(JSON.stringify(body)).not.toContain("must-not-leak");
    },
  );

  it.each([
    [new Error("must-not-leak"), "fetch_failed"],
    [new DOMException("must-not-leak", "TimeoutError"), "timeout"],
  ])("sanitizes fetch failures (%#)", async (error, category) => {
    mockFetch.mockRejectedValueOnce(error);
    const { body } = await check();
    expect(body.error).toBe(`trigger_report_${category}`);
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string)).toMatchObject({
      category,
      timeout_ms: 20_000,
      duration_ms: 0,
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("must-not-leak");
  });

  it("handles invalid JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("not JSON");
      },
    } as unknown as Response);
    expect((await check()).body).toMatchObject({
      status: "unknown",
      error: "trigger_report_invalid_json",
    });
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string).category).toBe(
      "invalid_json",
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("not JSON");
  });

  it.each([12_000, 25_000])(
    "allows slow reports but aborts at 20 seconds (%i ms)",
    async (latency) => {
      await import("../trigger-report");
      await import("../config");
      jest.useFakeTimers({ now: NOW });
      const controller = new AbortController();
      jest.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
        setTimeout(() => controller.abort(), milliseconds);
        return controller.signal;
      });
      mockFetch.mockImplementationOnce(
        (_url, options) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () =>
                resolve({
                  ok: true,
                  status: 200,
                  json: async () => report(),
                } as Response),
              latency,
            );
            options?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("must-not-leak"));
              },
              { once: true },
            );
          }),
      );
      let completed = false;
      const pending = check().then((response) => {
        completed = true;
        return response;
      });
      await jest.advanceTimersByTimeAsync(8_000);
      expect(completed).toBe(false);
      await jest.advanceTimersByTimeAsync(Math.min(latency, 20_000) - 8_000);
      const { response, body } = await pending;
      expect({ status: response.status, body }).toMatchObject({
        status: latency < 20_000 ? 200 : 503,
        body: { status: latency < 20_000 ? "healthy" : "unknown" },
      });
      if (latency < 20_000) {
        expect(body.status).toBe("healthy");
        expect(JSON.parse(infoSpy.mock.calls[0][0] as string)).toEqual({
          event: "trigger_agent_health_report_received",
          duration_ms: latency,
          status: "healthy",
        });
        expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(
          "must-not-leak",
        );
      } else {
        expect(body).toMatchObject({
          status: "unknown",
          error: "trigger_report_timeout",
        });
        expect(JSON.parse(warnSpy.mock.calls[0][0] as string)).toMatchObject({
          category: "timeout",
          duration_ms: 20_000,
        });
        expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
          "must-not-leak",
        );
      }
    },
  );

  it("does not fetch without authentication", async () => {
    delete process.env.TRIGGER_SECRET_KEY;
    expect((await check()).body.error).toBe("trigger_report_not_configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        TRIGGER_PREVIEW_BRANCH: "preview-a",
        VERCEL_GIT_COMMIT_REF: "commit-b",
      },
      "preview-a",
    ],
    [
      { VERCEL_GIT_COMMIT_REF: "commit-b", TRIGGER_DEV_BRANCH: "dev-c" },
      "commit-b",
    ],
    [{ TRIGGER_DEV_BRANCH: "dev-c" }, "dev-c"],
    [{ TRIGGER_DEV_BRANCH: "default" }, undefined],
  ])("matches Agent SDK branch selection (%#)", async (env, branch) => {
    Object.assign(process.env, env);
    respond();
    await check();
    expect(
      (mockFetch.mock.calls[0][1]?.headers as Record<string, string>)[
        "x-trigger-branch"
      ],
    ).toBe(branch);
  });

  it("supports the SDK API URL and access-token fallback", async () => {
    delete process.env.TRIGGER_SECRET_KEY;
    process.env.TRIGGER_ACCESS_TOKEN = "test-access-token";
    process.env.TRIGGER_API_URL = "https://trigger.example.test";
    respond();
    await check();
    expect(mockFetch.mock.calls[0][0]?.toString()).toBe(
      "https://trigger.example.test/api/v1/reports/health?period=1h&format=json",
    );
    expect(mockFetch.mock.calls[0][1]?.headers).toMatchObject({
      authorization: "Bearer test-access-token",
    });
  });

  it("rechecks the original timestamp on a stored report", async () => {
    const { freshReport } = await import("../trigger-report");
    const result = {
      status: "healthy" as const,
      generatedAt: new Date(NOW.getTime() - 290_000).toISOString(),
    };
    expect(freshReport(result).status).toBe("healthy");
    jest.mocked(Date.now).mockReturnValue(NOW.getTime() + 20_000);
    expect(freshReport(result).error).toBe("trigger_report_stale");
  });
});
