import { runProbe } from "../trigger-probe";

jest.mock("node:timers/promises", () => ({
  setTimeout: (
    ms: number,
    _value: unknown,
    { signal }: { signal: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve(undefined);
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    }),
}));
const mockFetch = jest.fn();
const originalFetch = global.fetch;
const config = {
  token: "test-key",
  baseURL: "https://trigger.test",
  branch: "preview-health",
};
let nonce: string;
let status: string;
let output: unknown;
beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-09-14T12:00:00Z") });
  jest.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  mockFetch.mockReset();
  global.fetch = mockFetch;
  status = "COMPLETED";
  output = undefined;
  mockFetch.mockImplementation(async (url, options) => {
    if (url.pathname.endsWith("/trigger")) {
      nonce = JSON.parse(options.body).payload.nonce;
      return { ok: true, json: async () => ({ id: "run_probe123" }) };
    }
    return {
      ok: true,
      json: async () => ({
        id: "run_probe123",
        taskIdentifier: "agent-health-probe",
        status,
        output: output ?? { nonce },
      }),
    };
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  global.fetch = originalFetch;
});

it("requires task completion and matching output from the selected environment", async () => {
  expect(await runProbe(config)).toEqual({
    status: "healthy",
    checkedAt: "2026-09-14T12:00:00.000Z",
  });
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(mockFetch.mock.calls[0][0].toString()).toBe(
    "https://trigger.test/api/v1/tasks/agent-health-probe/trigger",
  );
  expect(mockFetch.mock.calls[1][0].toString()).toBe(
    "https://trigger.test/api/v3/runs/run_probe123",
  );
  for (const [, options] of mockFetch.mock.calls) {
    expect(options.headers).toMatchObject({
      authorization: "Bearer test-key",
      "x-trigger-branch": "preview-health",
    });
    expect(options).toMatchObject({ redirect: "error", cache: "no-store" });
  }
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).options.ttl).toBe("1m");
});
it("does not accept a mismatched completion output", async () => {
  output = { nonce: "wrong" };
  expect(await runProbe(config)).toMatchObject({
    status: "unknown",
    error: "trigger_probe_invalid_output",
  });
});
it.each([
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
  "CANCELED",
])("detects terminal run failure %s", async (s) => {
  status = s;
  expect(await runProbe(config)).toMatchObject({
    status: "failing",
    error: "trigger_probe_failed",
  });
});
it("waits for a queued run to complete", async () => {
  status = "QUEUED";
  const pending = runProbe(config);
  await jest.advanceTimersByTimeAsync(2_000);
  status = "COMPLETED";
  await jest.advanceTimersByTimeAsync(2_000);
  expect((await pending).status).toBe("healthy");
});
it("bounds a stuck queue without treating submission as success", async () => {
  status = "QUEUED";
  const pending = runProbe(config);
  await jest.advanceTimersByTimeAsync(40_000);
  expect(await pending).toMatchObject({
    status: "unknown",
    error: "trigger_probe_timeout",
  });
});
it("bounds an unresponsive API and sanitizes errors", async () => {
  mockFetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("must-not-leak")),
          { once: true },
        );
      }),
  );
  const pending = runProbe(config);
  await jest.advanceTimersByTimeAsync(40_000);
  const result = await pending;
  expect(result).toMatchObject({
    status: "unknown",
    error: "trigger_probe_timeout",
  });
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
});
it.each([401, 403, 429, 503])(
  "sanitizes upstream HTTP %s errors",
  async (code) => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: code,
      json: async () => ({ error: "must-not-leak" }),
    });
    expect(await runProbe(config)).toMatchObject({
      status: "unknown",
      error: "trigger_probe_unavailable",
    });
  },
);
it.each([{ id: "../../wrong" }, {}])(
  "rejects an invalid submission response (%#)",
  async (body) => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => body });
    expect(await runProbe(config)).toMatchObject({
      status: "unknown",
      error: "trigger_probe_invalid",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  {
    id: "run_other",
    taskIdentifier: "agent-health-probe",
    status: "COMPLETED",
  },
  { id: "run_probe123", taskIdentifier: "other-task", status: "COMPLETED" },
  {
    id: "run_probe123",
    taskIdentifier: "agent-health-probe",
    status: "UNKNOWN_FUTURE_STATUS",
  },
])("rejects mismatched or unknown run responses (%#)", async (body) => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ id: "run_probe123" }),
  });
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => body });
  expect(await runProbe(config)).toMatchObject({
    status: "unknown",
    error: "trigger_probe_invalid",
  });
});
