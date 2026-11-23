/** @jest-environment node */
import fixture from "@/scripts/egress/tests/credentials.json";
import { telemetrySignature } from "@/lib/cloud-network/egress-telemetry";

const mockStore = new Map<string, string>();
const mockRedis = { available: true, fail: false, calls: 0 };
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => {
    if (!mockRedis.available) return null;
    const read = (key: string) => {
      const value = mockStore.get(key);
      return value === undefined ? null : JSON.parse(value);
    };
    return {
      set: async (key: string, value: string, opts?: { nx?: boolean }) => {
        mockRedis.calls++;
        if (mockRedis.fail) throw new Error("store down");
        if (opts?.nx && mockStore.has(key)) return null;
        mockStore.set(key, value);
        return "OK";
      },
      get: async (key: string) => read(key),
    };
  },
}));

import { POST } from "../route";

const vector = fixture.telemetryVector;
const NOW_MS = Number(vector.timestamp) * 1000;
const URL = "https://app.example.test/api/internal/egress-telemetry";
const originalEnv = process.env;

function signed(
  body: string | ReadableStream<Uint8Array> = vector.body,
  {
    region = "us",
    key = fixture.telemetryKeys.us,
    timestamp = vector.timestamp,
    headers = {},
  }: {
    region?: string;
    key?: string;
    timestamp?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const signature =
    typeof body === "string"
      ? telemetrySignature(
          Buffer.from(key, "hex"),
          region as "us",
          timestamp,
          Buffer.from(body),
        )
      : "0".repeat(64);
  return new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hackerai-egress-region": region,
      "x-hackerai-egress-timestamp": timestamp,
      "x-hackerai-egress-signature": `v1=${signature}`,
      ...headers,
    },
    body,
    ...(typeof body === "string" ? {} : { duplex: "half" }),
  } as RequestInit);
}

const post = async (request: Request) => {
  const response = await POST(request as never);
  return { status: response.status, body: await response.json() };
};

let logs: jest.SpyInstance[];
beforeEach(() => {
  process.env = {
    ...originalEnv,
    E2B_EGRESS_TELEMETRY_US_KEY: fixture.telemetryKeys.us,
    E2B_EGRESS_TELEMETRY_EU_KEY: fixture.telemetryKeys.eu,
  };
  mockStore.clear();
  Object.assign(mockRedis, { available: true, fail: false, calls: 0 });
  jest.spyOn(Date, "now").mockReturnValue(NOW_MS);
  logs = (["info", "warn", "error"] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {}),
  );
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = originalEnv;
});

it("stores a signed batch once, acknowledges its retry and returns no telemetry", async () => {
  expect(await post(signed())).toEqual({
    status: 200,
    body: { status: "accepted" },
  });
  const stored = [...mockStore.entries()];
  expect(stored.map(([key]) => key)).toEqual([
    "egress-telemetry:v1:us:minute:30000000",
  ]);
  // A retry after an uncertain acknowledgement is re-signed with a fresh time.
  expect(
    await post(
      signed(vector.body, { timestamp: String(Number(vector.timestamp) + 60) }),
    ),
  ).toEqual({ status: 200, body: { status: "duplicate" } });
  expect([...mockStore.entries()]).toEqual(stored);
  expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(
    fixture.vectors[0].owner,
  );
});

it("logs one fixed-field receipt per ingested minute with its delivery delay", async () => {
  // Delivered 95 seconds after the batch's minute ended, as after an outage.
  jest.mocked(Date.now).mockReturnValue(NOW_MS + 155_000);
  await post(signed());
  await post(signed());
  await post(signed(vector.body.replace(":3,", ":30,")));
  const entries = logs
    .flatMap((log) => log.mock.calls)
    .map(([entry]) => JSON.parse(entry));
  const receipt = (outcome: string) => ({
    timestamp: expect.any(String),
    level: "info",
    event: "egress_telemetry_received",
    service: "hackerai-web",
    environment: expect.any(String),
    region: "us",
    minute: 30_000_000,
    minuteStart: new Date(30_000_000 * 60_000).toISOString(),
    outcome,
    delayAfterMinuteEndS: 95,
  });
  // No counts or references; a conflict keeps only its rejection log.
  expect(entries).toEqual([
    receipt("accepted"),
    receipt("duplicate"),
    expect.objectContaining({
      event: "egress_telemetry_rejected",
      reason: "conflict",
    }),
  ]);
});

it("rejects a different body for a stored minute without changing it", async () => {
  await post(signed());
  const stored = [...mockStore.entries()];
  const changed = vector.body.replace(":3,", ":30,");
  expect(await post(signed(changed))).toEqual({
    status: 409,
    body: { error: "batch_conflict" },
  });
  expect([...mockStore.entries()]).toEqual(stored);
});

it.each<[string, Request]>([
  [
    "the other region's key",
    signed(vector.body, { key: fixture.telemetryKeys.eu }),
  ],
  [
    "a signature for another region",
    signed(vector.body, {
      region: "eu",
      key: fixture.telemetryKeys.us,
    }),
  ],
  [
    "a stale timestamp",
    signed(vector.body, { timestamp: String(Number(vector.timestamp) - 301) }),
  ],
  [
    "a tampered body",
    new Request(URL, {
      method: "POST",
      headers: {
        "x-hackerai-egress-region": "us",
        "x-hackerai-egress-timestamp": vector.timestamp,
        "x-hackerai-egress-signature": `v1=${vector.signature}`,
      },
      body: vector.body.replace(":3,", ":30,"),
    }),
  ],
  ["an unknown region", signed(vector.body, { region: "ap" })],
  [
    "a missing signature",
    signed(vector.body, { headers: { "x-hackerai-egress-signature": "" } }),
  ],
])("rejects %s before any store access", async (_label, request) => {
  expect(await post(request)).toEqual({
    status: 401,
    body: { error: "unauthorized" },
  });
  expect(mockRedis.calls).toBe(0);
});

it("rejects a correctly signed batch claiming another region", async () => {
  const body = vector.body.replace('"region":"us"', '"region":"eu"');
  expect(await post(signed(body))).toEqual({
    status: 400,
    body: { error: "invalid_payload" },
  });
  expect(mockRedis.calls).toBe(0);
});

it.each([
  [
    "an unknown field",
    vector.body.replace('"version":1', '"version":1,"target":"x"'),
  ],
  ["invalid JSON", vector.body.slice(0, -1)],
  ["an empty body", ""],
])("rejects a signed payload with %s", async (_label, body) => {
  expect(await post(signed(body))).toEqual({
    status: 400,
    body: { error: "invalid_payload" },
  });
  expect(mockRedis.calls).toBe(0);
});

it("rejects a declared oversized body", async () => {
  const response = await post(
    signed(vector.body, { headers: { "content-length": String(200 * 1024) } }),
  );
  expect(response).toEqual({
    status: 413,
    body: { error: "payload_too_large" },
  });
});

it("bounds a chunked body without a declared length", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Far more than the limit if read to the end.
      if (++pulled > 64) return controller.close();
      controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
    },
  });
  expect(await post(signed(stream))).toEqual({
    status: 413,
    body: { error: "payload_too_large" },
  });
  expect(pulled).toBeLessThan(64);
  expect(mockRedis.calls).toBe(0);
});

it("fails closed when the region's key is missing or shared", async () => {
  delete process.env.E2B_EGRESS_TELEMETRY_US_KEY;
  expect(await post(signed())).toEqual({
    status: 503,
    body: { error: "telemetry_unavailable" },
  });
  process.env.E2B_EGRESS_TELEMETRY_US_KEY = fixture.telemetryKeys.eu;
  expect(
    (await post(signed(vector.body, { key: fixture.telemetryKeys.eu }))).status,
  ).toBe(503);
  expect(mockRedis.calls).toBe(0);
});

it("asks the collector to retry when the store is unavailable", async () => {
  mockRedis.fail = true;
  expect(await post(signed())).toEqual({
    status: 503,
    body: { error: "telemetry_unavailable" },
  });
  mockRedis.fail = false;
  expect((await post(signed())).body).toEqual({ status: "accepted" });
  mockRedis.available = false;
  expect((await post(signed())).status).toBe(503);
});
