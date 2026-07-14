import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

jest.mock("../_generated/server", () => ({
  internalAction: jest.fn((config: unknown) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    boolean: jest.fn(() => "boolean"),
    literal: jest.fn(() => "literal"),
    number: jest.fn(() => "number"),
    object: jest.fn(() => "object"),
    optional: jest.fn(() => "optional"),
    string: jest.fn(() => "string"),
    union: jest.fn(() => "union"),
  },
}));

const mockStripe = jest.fn();
jest.mock("stripe", () => ({
  __esModule: true,
  default: mockStripe,
}));

const mockWorkOS = jest.fn();
jest.mock("@workos-inc/node", () => ({ WorkOS: mockWorkOS }));

const mockRunPro20UsageBackfill = jest.fn();
jest.mock("../../lib/billing/pro-20-usage-backfill", () => ({
  runPro20UsageBackfill: mockRunPro20UsageBackfill,
}));

const ENVIRONMENT_VARIABLES = [
  "STRIPE_SECRET_KEY",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_VARIABLES.map((name) => [name, process.env[name]]),
);

async function callRun(args: Record<string, unknown> = {}) {
  const { run } = await import("../pro20UsageBackfill");
  return (run as unknown as { handler: Function }).handler({}, args);
}

describe("Pro $20 Convex backfill action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_live_test_key";
    process.env.WORKOS_API_KEY = "sk_legacy_production_workos";
    process.env.WORKOS_CLIENT_ID = "client_test";
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    mockStripe.mockImplementation((key) => ({ key }));
    mockWorkOS.mockImplementation((key, options) => ({ key, options }));
    mockRunPro20UsageBackfill.mockResolvedValue({
      summary: { mode: "dry-run" },
    } as never);
  });

  afterAll(() => {
    for (const name of ENVIRONMENT_VARIABLES) {
      const originalValue = originalEnvironment[name];
      if (originalValue === undefined) delete process.env[name];
      else process.env[name] = originalValue;
    }
  });

  it("runs dry-run by default using Convex environment credentials", async () => {
    await callRun();

    expect(mockStripe).toHaveBeenCalledWith("sk_live_test_key");
    expect(mockWorkOS).toHaveBeenCalledWith("sk_legacy_production_workos", {
      clientId: "client_test",
    });
    expect(mockRunPro20UsageBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        apply: false,
        expectedSubscriptions: undefined,
        expectedFingerprint: undefined,
      }),
    );
  });

  it("rejects a non-live Stripe key before constructing any clients", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_local";

    await expect(callRun()).rejects.toThrow("without a live Stripe key");
    expect(mockStripe).not.toHaveBeenCalled();
    expect(mockWorkOS).not.toHaveBeenCalled();
    expect(mockRunPro20UsageBackfill).not.toHaveBeenCalled();
  });

  it("rejects apply without the exact confirmation", async () => {
    await expect(
      callRun({
        apply: true,
        expectedSubscriptions: 1,
        expectedFingerprint: "fingerprint",
      }),
    ).rejects.toThrow("Apply requires confirmation");
    expect(mockStripe).not.toHaveBeenCalled();
    expect(mockRunPro20UsageBackfill).not.toHaveBeenCalled();
  });

  it("allows a legacy production key but rejects a test key for apply", async () => {
    await expect(
      callRun({
        apply: true,
        expectedSubscriptions: 1,
        expectedFingerprint: "fingerprint",
        confirmation: "APPLY_PRO_20_USAGE_BACKFILL",
      }),
    ).resolves.toBeDefined();

    process.env.WORKOS_API_KEY = "sk_test_workos";

    await expect(callRun()).resolves.toBeDefined();
    await expect(
      callRun({
        apply: true,
        expectedSubscriptions: 1,
        expectedFingerprint: "fingerprint",
        confirmation: "APPLY_PRO_20_USAGE_BACKFILL",
      }),
    ).rejects.toThrow("with a WorkOS test key");
    expect(mockRunPro20UsageBackfill).toHaveBeenCalledTimes(2);
  });

  it("rejects apply without the dry-run count", async () => {
    await expect(
      callRun({
        apply: true,
        expectedFingerprint: "fingerprint",
        confirmation: "APPLY_PRO_20_USAGE_BACKFILL",
      }),
    ).rejects.toThrow("Apply requires expectedSubscriptions");
    expect(mockStripe).not.toHaveBeenCalled();
    expect(mockRunPro20UsageBackfill).not.toHaveBeenCalled();
  });

  it("rejects apply without the dry-run fingerprint", async () => {
    await expect(
      callRun({
        apply: true,
        expectedSubscriptions: 1,
        confirmation: "APPLY_PRO_20_USAGE_BACKFILL",
      }),
    ).rejects.toThrow("Apply requires expectedFingerprint");
    expect(mockStripe).not.toHaveBeenCalled();
    expect(mockRunPro20UsageBackfill).not.toHaveBeenCalled();
  });

  it("passes the guarded dry-run snapshot to the shared backfill", async () => {
    await callRun({
      apply: true,
      expectedSubscriptions: 1,
      expectedFingerprint: "fingerprint",
      confirmation: "APPLY_PRO_20_USAGE_BACKFILL",
    });

    expect(mockRunPro20UsageBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        apply: true,
        expectedSubscriptions: 1,
        expectedFingerprint: "fingerprint",
      }),
    );
  });

  it("requires Redis credentials only for apply", async () => {
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    await expect(callRun()).resolves.toBeDefined();
    await expect(
      callRun({
        apply: true,
        expectedSubscriptions: 1,
        expectedFingerprint: "fingerprint",
        confirmation: "APPLY_PRO_20_USAGE_BACKFILL",
      }),
    ).rejects.toThrow("UPSTASH_REDIS_REST_TOKEN is not configured");
  });
});
