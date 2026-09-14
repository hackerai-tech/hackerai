import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

jest.mock("next/server", () => ({
  NextResponse: class MockNextResponse {
    status: number;
    headers: Headers;
    constructor(
      private body: unknown,
      init?: ResponseInit,
    ) {
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init);
    }
    async json() {
      return this.body;
    }
  },
}));

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
  const { GET } = await import("../route");
  const response = await GET();
  return { response, body: await response.json() };
}

describe("GET /api/health/trigger-agent-mode", () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockReset();
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
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
    jest.restoreAllMocks();
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("uses authenticated reports and exposes only the health summary", async () => {
    respond();
    const { response, body } = await check();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
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
      ok: true,
      source: "trigger_report",
      checkedAt: expect.any(String),
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
        ok: true,
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
      expect(body).toMatchObject({ ok: false, status: "failing" });
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

  it.each([-121_000, 31_000])(
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
    new Error("must-not-leak"),
    new DOMException("must-not-leak", "TimeoutError"),
  ])("sanitizes fetch failures (%#)", async (error) => {
    mockFetch.mockRejectedValueOnce(error);
    const { body } = await check();
    expect(body.error).toBe("trigger_report_fetch_failed");
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
    expect((await check()).body.status).toBe("unknown");
  });

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

  it("coalesces concurrent probes and refreshes after 60 seconds", async () => {
    respond();
    const { GET } = await import("../route");
    await Promise.all([GET(), GET(), GET()]);
    await GET();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    jest.mocked(Date.now).mockReturnValue(NOW.getTime() + 60_000);
    respond({ ...report(), summary: { severity: "crit" } });
    expect((await GET()).status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("rechecks report freshness on cache hits", async () => {
    respond({
      ...report(),
      generatedAt: new Date(NOW.getTime() - 110_000).toISOString(),
    });
    const { GET } = await import("../route");
    expect((await GET()).status).toBe(200);
    jest.mocked(Date.now).mockReturnValue(NOW.getTime() + 20_000);
    expect((await (await GET()).json()).error).toBe("trigger_report_stale");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("bounds retries after failures and recovers after cache expiry", async () => {
    respond({}, 500);
    const { GET } = await import("../route");
    expect((await GET()).status).toBe(503);
    expect((await GET()).status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    jest.mocked(Date.now).mockReturnValue(NOW.getTime() + 60_000);
    respond();
    expect((await GET()).status).toBe(200);
  });

  it.each(["TRIGGER_SECRET_KEY", "TRIGGER_API_URL", "TRIGGER_PREVIEW_BRANCH"])(
    "does not reuse another target's cached result when %s changes",
    async (name) => {
      respond();
      const { GET } = await import("../route");
      await GET();
      process.env[name] =
        name === "TRIGGER_API_URL" ? "https://other.example.test" : "other";
      respond({}, 403);
      expect((await GET()).status).toBe(503);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    },
  );
});
