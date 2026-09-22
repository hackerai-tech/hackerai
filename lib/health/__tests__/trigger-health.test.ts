import { readTriggerHealth, refreshTriggerHealth } from "../trigger-health";
import { getTriggerHealthConfig, healthCacheKey } from "../config";
import { getReport } from "../trigger-report";
import { runProbe } from "../trigger-probe";

const mockGet = jest.fn();
const mockSet = jest.fn();
const mockEval = jest.fn();
jest.mock("@upstash/redis", () => ({
  Redis: jest
    .fn()
    .mockImplementation(() => ({ get: mockGet, set: mockSet, eval: mockEval })),
}));
jest.mock("../trigger-report", () => ({
  ...jest.requireActual("../trigger-report"),
  getReport: jest.fn(),
}));
jest.mock("../trigger-probe", () => ({ runProbe: jest.fn() }));
const reportFetch = jest.mocked(getReport);
const probeFetch = jest.mocked(runProbe);
const NOW = new Date("2026-09-14T12:00:00Z");
const env = process.env;
const snapshot = () => ({
  probe: { status: "healthy", checkedAt: NOW.toISOString() },
  report: { status: "healthy", generatedAt: NOW.toISOString() },
  reportAttemptAt: NOW.toISOString(),
});
beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  jest.clearAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  process.env = {
    ...env,
    TRIGGER_SECRET_KEY: "test-trigger-key",
    UPSTASH_REDIS_REST_URL: "https://redis.test",
    UPSTASH_REDIS_REST_TOKEN: "test-redis-key",
  };
  mockGet.mockResolvedValue(null);
  mockSet.mockResolvedValue("OK");
  mockEval.mockResolvedValue(1);
  reportFetch.mockResolvedValue({
    status: "healthy",
    generatedAt: NOW.toISOString(),
  });
  probeFetch.mockResolvedValue({
    status: "healthy",
    checkedAt: NOW.toISOString(),
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  process.env = env;
});
const published = () => JSON.parse(mockEval.mock.calls[0][2][1]);

it("stores independent probe evidence even when report fetch times out", async () => {
  reportFetch.mockResolvedValue({
    status: "unknown",
    error: "trigger_report_timeout",
  });
  expect(await refreshTriggerHealth()).toEqual({ ok: true });
  expect(published()).toMatchObject({
    probe: { status: "healthy" },
    report: { status: "unknown" },
  });
});
it("coalesces collectors across instances and never triggers work from public reads", async () => {
  mockSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
  const results = await Promise.all([
    refreshTriggerHealth(),
    refreshTriggerHealth(),
  ]);
  expect(results).toContainEqual({ ok: true, skipped: true });
  expect(probeFetch).toHaveBeenCalledTimes(1);
  expect(reportFetch).toHaveBeenCalledTimes(1);
  mockGet.mockResolvedValue(snapshot());
  await Promise.all([readTriggerHealth(), readTriggerHealth()]);
  expect(probeFetch).toHaveBeenCalledTimes(1);
  expect(reportFetch).toHaveBeenCalledTimes(1);
});
it("preserves the original report timestamp for short reporting failures", async () => {
  const previous = snapshot();
  previous.report.generatedAt = new Date(NOW.getTime() - 120_000).toISOString();
  mockGet.mockResolvedValue(previous);
  reportFetch.mockResolvedValue({
    status: "unknown",
    error: "trigger_report_timeout",
  });
  await refreshTriggerHealth();
  expect(published()).toMatchObject({
    report: previous.report,
    reportRefreshError: "trigger_report_timeout",
  });
});
it.each(["failing", "unknown"] as const)(
  "immediately replaces old healthy reports with explicit %s evidence",
  async (status) => {
    mockGet.mockResolvedValue(snapshot());
    reportFetch.mockResolvedValue({ status, generatedAt: NOW.toISOString() });
    await refreshTriggerHealth();
    expect(published().report.status).toBe(status);
  },
);
it("does not retain a report after credentials are denied", async () => {
  mockGet.mockResolvedValue(snapshot());
  reportFetch.mockResolvedValue({
    status: "unknown",
    error: "trigger_report_unavailable",
    sourceStatus: 403,
  });
  await refreshTriggerHealth();
  expect(published().report.status).toBe("unknown");
});
it("does not extend report evidence beyond five minutes", async () => {
  const previous = snapshot();
  previous.report.generatedAt = new Date(NOW.getTime() - 300_001).toISOString();
  mockGet.mockResolvedValue(previous);
  reportFetch.mockResolvedValue({
    status: "unknown",
    error: "trigger_report_timeout",
  });
  await refreshTriggerHealth();
  expect(published().report.status).toBe("unknown");
});
it.each([-180_001, 30_001])(
  "expires old or future probe timestamps on every read (%i)",
  async (offset) => {
    const previous = snapshot();
    previous.probe.checkedAt = new Date(NOW.getTime() + offset).toISOString();
    mockGet.mockResolvedValue(previous);
    expect((await readTriggerHealth()).probe).toMatchObject({
      status: "unknown",
      error: "health_data_stale",
      checkedAt: previous.probe.checkedAt,
    });
  },
);
it("expires reports independently of a fresh probe", async () => {
  const previous = snapshot();
  previous.report.generatedAt = new Date(NOW.getTime() - 300_001).toISOString();
  mockGet.mockResolvedValue(previous);
  expect(await readTriggerHealth()).toMatchObject({
    probe: { status: "healthy" },
    report: { status: "unknown", error: "trigger_report_stale" },
  });
});
it("never reports healthy when missing, invalid, or unavailable storage is read", async () => {
  for (const value of [null, {}, { probe: { status: "healthy" } }]) {
    mockGet.mockResolvedValue(value);
    expect((await readTriggerHealth()).probe.status).toBe("unknown");
  }
  mockGet.mockRejectedValue(new Error("must-not-leak"));
  expect(await readTriggerHealth()).toMatchObject({
    probe: { status: "unknown", error: "health_store_unavailable" },
  });
});
it.each([
  "TRIGGER_SECRET_KEY",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
])("does not collect without %s", async (name) => {
  delete process.env[name];
  delete process.env.TRIGGER_ACCESS_TOKEN;
  expect(await refreshTriggerHealth()).toMatchObject({
    ok: false,
    error: "health_monitor_not_configured",
  });
  expect((await readTriggerHealth()).probe.status).toBe("unknown");
  expect(probeFetch).not.toHaveBeenCalled();
});
it("rejects a stale writer whose lease expired", async () => {
  mockEval.mockResolvedValue(0);
  expect(await refreshTriggerHealth()).toEqual({
    ok: false,
    error: "health_collection_lease_expired",
  });
});
it("recovers with new evidence after a failed probe", async () => {
  const previous = snapshot();
  previous.probe.status = "unknown";
  mockGet.mockResolvedValue(previous);
  await refreshTriggerHealth();
  mockGet.mockResolvedValue(published());
  expect((await readTriggerHealth()).probe.status).toBe("healthy");
});
it.each([
  "TRIGGER_SECRET_KEY",
  "TRIGGER_API_URL",
  "TRIGGER_PREVIEW_BRANCH",
  "VERCEL_ENV",
  "VERCEL_PROJECT_ID",
])("isolates storage when %s changes", (name) => {
  const before = healthCacheKey(getTriggerHealthConfig()!);
  process.env[name] = "another-target";
  expect(healthCacheKey(getTriggerHealthConfig()!)).not.toBe(before);
  expect(before).not.toContain("test-trigger-key");
});
