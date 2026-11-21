/** @jest-environment node */
import fixture from "../../../scripts/egress/tests/credentials.json";
import {
  ingestTelemetryBatch,
  MAX_BATCH_IDENTITIES,
  readTelemetryMinutes,
  TELEMETRY_FRESHNESS_S,
  telemetryBatchSchema,
  telemetryKey,
  telemetrySignature,
  verifyTelemetrySignature,
} from "../egress-telemetry";

const US_KEY = Buffer.from(fixture.telemetryKeys.us, "hex");
const EU_KEY = Buffer.from(fixture.telemetryKeys.eu, "hex");
const vector = fixture.telemetryVector;
const BODY = Buffer.from(vector.body);
const NOW_MS = Number(vector.timestamp) * 1000;
const batch = () => telemetryBatchSchema.parse(JSON.parse(vector.body));

/** Upstash-like store: values are JSON-deserialized on read. */
function fakeTelemetryRedis() {
  const store = new Map<string, string>();
  const read = (key: string) => {
    const value = store.get(key);
    return value === undefined ? null : JSON.parse(value);
  };
  return {
    store,
    set: jest.fn(
      async (key: string, value: string, opts?: { nx?: boolean }) => {
        if (opts?.nx && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
    ),
    get: jest.fn(async (key: string) => read(key)),
    mget: jest.fn(async (...keys: string[]) => keys.map(read)),
  };
}

describe("telemetry signatures", () => {
  const verify = (
    overrides: Partial<Parameters<typeof verifyTelemetrySignature>[0]>,
  ) =>
    verifyTelemetrySignature({
      key: US_KEY,
      region: "us",
      timestamp: vector.timestamp,
      signature: `v1=${vector.signature}`,
      body: BODY,
      nowMs: NOW_MS,
      ...overrides,
    });

  it("matches the vector the Python collector signs", () => {
    expect(telemetrySignature(US_KEY, "us", vector.timestamp, BODY)).toBe(
      vector.signature,
    );
    expect(verify({})).toBe(true);
  });

  it("accepts the freshness boundary and rejects anything older or newer", () => {
    expect(verify({ nowMs: NOW_MS + TELEMETRY_FRESHNESS_S * 1000 })).toBe(true);
    expect(verify({ nowMs: NOW_MS + (TELEMETRY_FRESHNESS_S + 1) * 1000 })).toBe(
      false,
    );
    expect(verify({ nowMs: NOW_MS - (TELEMETRY_FRESHNESS_S + 1) * 1000 })).toBe(
      false,
    );
  });

  it.each<[string, Partial<Parameters<typeof verifyTelemetrySignature>[0]>]>([
    ["another region's key", { key: EU_KEY }],
    ["the signature replayed for another region", { region: "eu" }],
    [
      "a modified body",
      { body: Buffer.from(vector.body.replace(":3,", ":30,")) },
    ],
    // The timestamp is signed: refreshing it needs a new signature.
    [
      "a changed timestamp",
      { timestamp: String(Number(vector.timestamp) + 1) },
    ],
    ["a missing timestamp", { timestamp: null }],
    ["a non-decimal timestamp", { timestamp: "1.8e9" }],
    ["a missing signature", { signature: null }],
    ["an unversioned signature", { signature: vector.signature }],
    [
      "an uppercase signature",
      { signature: `v1=${vector.signature.toUpperCase()}` },
    ],
    ["a short signature", { signature: `v1=${vector.signature.slice(2)}` }],
  ])("rejects %s", (_label, overrides) => {
    expect(verify(overrides)).toBe(false);
  });

  it("requires distinct well-formed regional keys", () => {
    const env = {
      E2B_EGRESS_TELEMETRY_US_KEY: fixture.telemetryKeys.us,
      E2B_EGRESS_TELEMETRY_EU_KEY: fixture.telemetryKeys.eu,
    };
    expect(telemetryKey("us", env)?.toString("hex")).toBe(
      fixture.telemetryKeys.us,
    );
    expect(telemetryKey("eu", env)?.toString("hex")).toBe(
      fixture.telemetryKeys.eu,
    );
    // A region without its own key is disabled, not served by the other.
    expect(
      telemetryKey("eu", {
        E2B_EGRESS_TELEMETRY_US_KEY: fixture.telemetryKeys.us,
      }),
    ).toBeNull();
    expect(
      telemetryKey("us", {
        E2B_EGRESS_TELEMETRY_US_KEY: fixture.telemetryKeys.us,
        E2B_EGRESS_TELEMETRY_EU_KEY: fixture.telemetryKeys.us,
      }),
    ).toBeNull();
    expect(
      telemetryKey("us", { E2B_EGRESS_TELEMETRY_US_KEY: "3C".repeat(32) }),
    ).toBeNull();
    // An attribution key in the same process is never accepted for telemetry.
    expect(
      telemetryKey("us", {
        ...env,
        E2B_EGRESS_ATTRIBUTION_EU_KEY: fixture.telemetryKeys.us,
      }),
    ).toBeNull();
    expect(
      telemetryKey("us", {
        ...env,
        E2B_EGRESS_ATTRIBUTION_US_KEY: fixture.attributionKeys.us,
        E2B_EGRESS_ATTRIBUTION_EU_KEY: fixture.attributionKeys.eu,
      })?.toString("hex"),
    ).toBe(fixture.telemetryKeys.us);
  });
});

describe("telemetry batch schema", () => {
  const base = JSON.parse(vector.body);
  const entry = (index: number) => ({
    owner: index.toString(16).padStart(32, "0"),
    workspace: "f".repeat(32),
    connections: 1,
  });

  it("accepts the bounded identity limit", () => {
    const counts = Array.from({ length: MAX_BATCH_IDENTITIES }, (_, i) =>
      entry(i),
    );
    expect(telemetryBatchSchema.safeParse({ ...base, counts }).success).toBe(
      true,
    );
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "identities over the limit",
      {
        counts: Array.from({ length: MAX_BATCH_IDENTITIES + 1 }, (_, i) =>
          entry(i),
        ),
      },
    ],
    ["a repeated identity", { counts: [entry(1), entry(1)] }],
    ["an unknown field", { destination: "example.test" }],
    [
      "an unknown count field",
      { counts: [{ ...entry(1), target: "example.test" }] },
    ],
    ["a zero count", { counts: [{ ...entry(1), connections: 0 }] }],
    ["a fractional count", { counts: [{ ...entry(1), connections: 1.5 }] }],
    ["a raw username", { counts: [{ ...entry(1), owner: "hae-v1-owner" }] }],
    ["another version", { version: 2 }],
    ["an unknown region", { region: "ap" }],
    ["a negative overflow", { overflowConnections: -1 }],
    ["a missing completeness flag", { complete: undefined }],
  ])("rejects %s", (_label, change) => {
    expect(telemetryBatchSchema.safeParse({ ...base, ...change }).success).toBe(
      false,
    );
  });
});

describe("telemetry ingestion", () => {
  it("stores a minute once and treats a retried identical body as a duplicate", async () => {
    const redis = fakeTelemetryRedis();
    expect(
      await ingestTelemetryBatch(redis as never, batch(), BODY, NOW_MS),
    ).toBe("accepted");
    const stored = [...redis.store.values()];
    expect(
      await ingestTelemetryBatch(redis as never, batch(), BODY, NOW_MS),
    ).toBe("duplicate");
    expect([...redis.store.values()]).toEqual(stored);

    // A different body for a stored minute never adds to the first.
    const changed = Buffer.from(vector.body.replace(":3,", ":30,"));
    const parsed = telemetryBatchSchema.parse(JSON.parse(changed.toString()));
    expect(
      await ingestTelemetryBatch(redis as never, parsed, changed, NOW_MS),
    ).toBe("conflict");
    expect([...redis.store.values()]).toEqual(stored);

    const [minute, missing] = await readTelemetryMinutes(
      redis as never,
      "us",
      [30_000_000, 30_000_001],
    );
    expect(minute?.counts).toEqual([
      [fixture.vectors[0].owner, fixture.vectors[0].workspace, 3],
      [fixture.vectors[1].owner, fixture.vectors[1].workspace, 2],
    ]);
    // An absent minute stays unknown rather than becoming zero.
    expect(missing).toBeNull();
    expect(
      (await readTelemetryMinutes(redis as never, "eu", [30_000_000]))[0],
    ).toBeNull();
  });

  it("serializes concurrent identical uploads into one stored minute", async () => {
    const redis = fakeTelemetryRedis();
    const outcomes = await Promise.all(
      [0, 1, 2].map(() =>
        ingestTelemetryBatch(redis as never, batch(), BODY, NOW_MS),
      ),
    );
    expect(outcomes.sort()).toEqual(["accepted", "duplicate", "duplicate"]);
    expect(redis.store.size).toBe(1);
  });

  it.each([
    ["more than a day old", NOW_MS + (24 * 60 + 1) * 60_000],
    ["from the future", NOW_MS - 2 * 60_000],
  ])("acknowledges a batch %s without storing it", async (_label, nowMs) => {
    const redis = fakeTelemetryRedis();
    expect(
      await ingestTelemetryBatch(redis as never, batch(), BODY, nowMs),
    ).toBe("stale");
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("propagates a store failure so the collector retries", async () => {
    const redis = fakeTelemetryRedis();
    redis.set.mockRejectedValueOnce(new Error("store down"));
    await expect(
      ingestTelemetryBatch(redis as never, batch(), BODY, NOW_MS),
    ).rejects.toThrow();
    expect(
      await ingestTelemetryBatch(redis as never, batch(), BODY, NOW_MS),
    ).toBe("accepted");
  });
});
