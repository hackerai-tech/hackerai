jest.mock("@/lib/posthog/server", () => ({
  phLogger: { error: jest.fn() },
}));

import {
  CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS,
  classifyAwsCircuitFailure,
  recordAwsAccountHealthProbeSuccess,
  recordAwsSandboxAcquisitionFailure,
  recordAwsSandboxHalfOpenSuccess,
  resetCloudSandboxProviderCircuitStateForTests,
  resolveCloudSandboxProviderForRun,
} from "../cloud-sandbox-provider-circuit";

class FakeRedis {
  readonly values = new Map<string, unknown>();
  readonly expirations = new Map<string, number>();

  async get(key: string): Promise<unknown> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: unknown,
    options?: { nx?: boolean; ex?: number },
  ): Promise<"OK" | null> {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    if (options?.ex) this.expirations.set(key, options.ex);
    return "OK";
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.values.has(key)) return 0;
    this.expirations.set(key, seconds);
    return 1;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) removed++;
      this.expirations.delete(key);
    }
    return removed;
  }

  async eval<T>(_script: string, keys: string[], args: unknown[]): Promise<T> {
    const current = this.values.get(keys[0]);
    const serialized =
      typeof current === "string" ? current : JSON.stringify(current);
    if (serialized !== args[0]) return 0 as T;
    await this.del(...keys);
    return 1 as T;
  }
}

const originalProvider = process.env.CLOUD_SANDBOX_PROVIDER;
const originalAutoFailover = process.env.CLOUD_SANDBOX_AUTO_FAILOVER_ENABLED;
const originalE2bApiKey = process.env.E2B_API_KEY;

describe("cloud sandbox provider circuit", () => {
  beforeEach(() => {
    process.env.CLOUD_SANDBOX_PROVIDER = "aws-lambda-microvm";
    process.env.CLOUD_SANDBOX_AUTO_FAILOVER_ENABLED = "true";
    process.env.E2B_API_KEY = "test-e2b-key";
    resetCloudSandboxProviderCircuitStateForTests();
  });

  afterAll(() => {
    if (originalProvider === undefined)
      delete process.env.CLOUD_SANDBOX_PROVIDER;
    else process.env.CLOUD_SANDBOX_PROVIDER = originalProvider;
    if (originalAutoFailover === undefined) {
      delete process.env.CLOUD_SANDBOX_AUTO_FAILOVER_ENABLED;
    } else {
      process.env.CLOUD_SANDBOX_AUTO_FAILOVER_ENABLED = originalAutoFailover;
    }
    if (originalE2bApiKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = originalE2bApiKey;
  });

  test("classifies nested AWS account access failures", () => {
    const cause = Object.assign(new Error("account is suspended"), {
      name: "AccessDeniedException",
      $metadata: { httpStatusCode: 403 },
    });
    const error = new Error("Failed creating AWS sandbox", { cause });

    expect(classifyAwsCircuitFailure(error)).toEqual({
      failureClass: "account_access",
      failureName: "AccessDeniedException",
    });
  });

  test("classifies provider failures but ignores configuration errors", () => {
    expect(
      classifyAwsCircuitFailure(
        Object.assign(new Error("service unavailable"), {
          name: "InternalServerException",
          $metadata: { httpStatusCode: 503 },
        }),
      ),
    ).toEqual({
      failureClass: "provider_unavailable",
      failureName: "InternalServerException",
    });
    expect(
      classifyAwsCircuitFailure(
        Object.assign(new Error("bad release manifest"), {
          name: "ValidationException",
          $metadata: { httpStatusCode: 400 },
        }),
      ),
    ).toBeNull();
  });

  test("opens immediately for account access loss and selects E2B", async () => {
    const redis = new FakeRedis();
    const now = Date.parse("2026-08-25T18:00:00.000Z");
    const log = jest.fn();
    const error = Object.assign(new Error("denied"), {
      name: "AccessDeniedException",
      $metadata: { httpStatusCode: 403 },
    });

    await expect(
      recordAwsSandboxAcquisitionFailure(
        error,
        { requestId: "run-1", source: "health_probe" },
        { redis, now: () => now, log },
      ),
    ).resolves.toEqual({ opened: true, failureClass: "account_access" });

    await expect(
      resolveCloudSandboxProviderForRun(
        { requestId: "run-2" },
        { redis, now: () => now + 1, log },
      ),
    ).resolves.toMatchObject({
      provider: "e2b",
      reason: "circuit_open",
      circuitFailureClass: "account_access",
    });
    expect(log).toHaveBeenCalledWith(
      "warn",
      "cloud_sandbox_provider_circuit_opened",
      expect.objectContaining({ request_id: "run-1" }),
    );
  });

  test("requires three acquisition failures before opening a transient circuit", async () => {
    const redis = new FakeRedis();
    const error = Object.assign(new Error("unavailable"), {
      name: "InternalServerException",
      $metadata: { httpStatusCode: 503 },
    });
    const dependencies = { redis, now: () => 1_000, log: jest.fn() };

    await expect(
      recordAwsSandboxAcquisitionFailure(
        error,
        { source: "sandbox_acquisition" },
        dependencies,
      ),
    ).resolves.toMatchObject({ opened: false });
    await recordAwsSandboxAcquisitionFailure(
      error,
      { source: "sandbox_acquisition" },
      dependencies,
    );
    await expect(
      recordAwsSandboxAcquisitionFailure(
        error,
        { source: "sandbox_acquisition" },
        dependencies,
      ),
    ).resolves.toEqual({
      opened: true,
      failureClass: "provider_unavailable",
    });
  });

  test("does not open globally for a transient health-probe failure", async () => {
    const redis = new FakeRedis();
    const error = Object.assign(new Error("regional outage"), {
      name: "InternalServerException",
      $metadata: { httpStatusCode: 503 },
    });

    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(
        recordAwsSandboxAcquisitionFailure(
          error,
          { source: "health_probe" },
          { redis, now: () => 1_000, log: jest.fn() },
        ),
      ).resolves.toEqual({
        opened: false,
        failureClass: "provider_unavailable",
      });
    }
    expect(
      redis.values.has(CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.circuitKey),
    ).toBe(false);
  });

  test("allows only one half-open AWS run while other runs stay on E2B", async () => {
    const redis = new FakeRedis();
    const openedAt = "2026-08-25T18:00:00.000Z";
    const retryAt = "2026-08-25T18:15:00.000Z";
    redis.values.set(
      CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.circuitKey,
      JSON.stringify({
        version: 1,
        state: "open",
        failureClass: "provider_unavailable",
        failureName: "InternalServerException",
        openedAt,
        retryAt,
      }),
    );
    const now = Date.parse(retryAt) + 1;
    const dependencies = { redis, now: () => now, log: jest.fn() };

    await expect(
      resolveCloudSandboxProviderForRun({ requestId: "probe" }, dependencies),
    ).resolves.toMatchObject({
      provider: "aws-lambda-microvm",
      reason: "circuit_half_open_probe",
    });
    await expect(
      resolveCloudSandboxProviderForRun({ requestId: "other" }, dependencies),
    ).resolves.toMatchObject({ provider: "e2b", reason: "circuit_open" });
  });

  test("reopens immediately when the single half-open AWS run fails", async () => {
    const redis = new FakeRedis();
    const retryAt = "2026-08-25T18:15:00.000Z";
    const now = Date.parse(retryAt) + 1;
    redis.values.set(
      CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.circuitKey,
      JSON.stringify({
        version: 1,
        state: "open",
        failureClass: "provider_unavailable",
        failureName: "InternalServerException",
        openedAt: "2026-08-25T18:00:00.000Z",
        retryAt,
      }),
    );
    const dependencies = { redis, now: () => now, log: jest.fn() };
    await resolveCloudSandboxProviderForRun(
      { requestId: "half-open" },
      dependencies,
    );

    await expect(
      recordAwsSandboxAcquisitionFailure(
        Object.assign(new Error("still unavailable"), {
          name: "InternalServerException",
          $metadata: { httpStatusCode: 503 },
        }),
        { source: "sandbox_acquisition", halfOpenProbe: true },
        dependencies,
      ),
    ).resolves.toEqual({
      opened: true,
      failureClass: "provider_unavailable",
    });
    await expect(
      resolveCloudSandboxProviderForRun(
        { requestId: "next-run" },
        dependencies,
      ),
    ).resolves.toMatchObject({ provider: "e2b", reason: "circuit_open" });
    expect(
      redis.values.has(
        CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.halfOpenLockKey,
      ),
    ).toBe(false);
  });

  test("closes a half-open circuit after a successful AWS acquisition", async () => {
    const redis = new FakeRedis();
    redis.values.set(
      CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.circuitKey,
      JSON.stringify({
        version: 1,
        state: "open",
        failureClass: "provider_unavailable",
        failureName: "TimeoutError",
        openedAt: "2026-08-25T18:00:00.000Z",
        retryAt: "2026-08-25T18:15:00.000Z",
      }),
    );
    redis.values.set(
      CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.halfOpenLockKey,
      "probe",
    );

    await recordAwsSandboxHalfOpenSuccess(
      { requestId: "probe" },
      { redis, log: jest.fn() },
    );
    expect(
      redis.values.has(CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.circuitKey),
    ).toBe(false);
    expect(
      redis.values.has(
        CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.halfOpenLockKey,
      ),
    ).toBe(false);
  });

  test("health success closes account circuits but not provider-outage circuits", async () => {
    const redis = new FakeRedis();
    const setState = (
      failureClass: "account_access" | "provider_unavailable",
    ) =>
      redis.values.set(
        CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.circuitKey,
        JSON.stringify({
          version: 1,
          state: "open",
          failureClass,
          failureName: "failure",
          openedAt: "2026-08-25T18:00:00.000Z",
          retryAt: "2026-08-25T18:15:00.000Z",
        }),
      );

    setState("provider_unavailable");
    await recordAwsAccountHealthProbeSuccess({}, { redis, log: jest.fn() });
    expect(
      redis.values.has(CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.circuitKey),
    ).toBe(true);

    setState("account_access");
    await recordAwsAccountHealthProbeSuccess({}, { redis, log: jest.fn() });
    expect(
      redis.values.has(CLOUD_SANDBOX_PROVIDER_CIRCUIT_CONSTANTS.circuitKey),
    ).toBe(false);
  });

  test("manual E2B selection and disabled auto-failover bypass the circuit", async () => {
    const redis = new FakeRedis();
    process.env.CLOUD_SANDBOX_PROVIDER = "e2b";
    await expect(
      resolveCloudSandboxProviderForRun({}, { redis, log: jest.fn() }),
    ).resolves.toEqual({ provider: "e2b", reason: "configured_e2b" });

    process.env.CLOUD_SANDBOX_PROVIDER = "aws-lambda-microvm";
    process.env.CLOUD_SANDBOX_AUTO_FAILOVER_ENABLED = "false";
    await expect(
      resolveCloudSandboxProviderForRun({}, { redis, log: jest.fn() }),
    ).resolves.toEqual({
      provider: "aws-lambda-microvm",
      reason: "primary_aws",
    });
  });
});
