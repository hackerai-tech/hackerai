/** @jest-environment node */
import { POST } from "../route";
import {
  authorizeDesktopOperation,
  desktopOperationDigest,
} from "@/lib/desktop/authorized-operation";

const KEY_PREFIX = "desktop:authorized-operation:";
const START_MS = 1_800_000_000_000;
const SAMPLED_COMMAND_ID = "0f4d1c2e-8b7a-4c3d-9e1f-2a3b4c5d6e7f";
const UNSAMPLED_COMMAND_ID = "9f4d1c2e-8b7a-4c3d-9e1f-2a3b4c5d6e7f";

const mockEntries = new Map<string, unknown>();
const mockRedis = {
  setOptions: [] as unknown[],
  getdelCount: 0,
  lookupMs: 0,
  fail: false,
};
const mockClock = { nowMs: START_MS };

jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    // Upstash stores JSON, so issued records cannot carry getters or references.
    set: async (key: string, value: unknown, options: unknown) => {
      mockRedis.setOptions.push(options);
      mockEntries.set(key, JSON.parse(JSON.stringify(value)));
    },
    getdel: async (key: string) => {
      mockRedis.getdelCount += 1;
      if (mockRedis.fail) throw new Error("redis unavailable");
      mockClock.nowMs += mockRedis.lookupMs;
      const value = mockEntries.get(key) ?? null;
      mockEntries.delete(key);
      return value;
    },
  }),
}));

let info: jest.SpyInstance;

function request(id: string, payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/desktop/authorized-operation", {
    method: "POST",
    body: JSON.stringify({ id, digest: desktopOperationDigest(payload) }),
  });
}

function decisionLines(): string[] {
  return info.mock.calls.map(([line]) => line as string);
}

function decisionEvents(): unknown[] {
  return decisionLines().map((line) => JSON.parse(line));
}

function decisionEvent(fields: Record<string, unknown>) {
  return {
    event: "desktop_authorization_decision",
    desktop_authorization_decision_diagnostic_version: 1,
    operation_age_ms: 0,
    handler_elapsed_ms: 0,
    lookup_elapsed_ms: 0,
    timing_status: "within_bounds",
    ...fields,
  };
}

beforeEach(() => {
  mockEntries.clear();
  mockRedis.setOptions = [];
  mockRedis.getdelCount = 0;
  mockRedis.lookupMs = 0;
  mockRedis.fail = false;
  mockClock.nowMs = START_MS;
  jest.spyOn(Date, "now").mockImplementation(() => mockClock.nowMs);
  jest
    .spyOn(performance, "now")
    .mockImplementation(() => mockClock.nowMs - START_MS);
  info = jest.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

it("redeems one exact server-issued command and rejects substitution or replay", async () => {
  const command = {
    type: "command",
    commandId: SAMPLED_COMMAND_ID,
    command: "printf safe",
    env: { B: "2", A: "1" },
    targetConnectionId: "desktop-1",
  };
  const issuedCommand = structuredClone(command);
  const tamperedId = await authorizeDesktopOperation(
    "user-1",
    "desktop-1",
    command,
  );
  expect(command).toEqual(issuedCommand);
  expect(mockRedis.setOptions).toEqual([{ ex: 90 }]);
  expect(mockEntries.get(`${KEY_PREFIX}${tamperedId}`)).toEqual({
    userId: "user-1",
    connectionId: "desktop-1",
    digest: desktopOperationDigest(command),
    diagnostic: {
      version: 1,
      commandId: SAMPLED_COMMAND_ID,
      issuedAtMs: START_MS,
    },
  });

  const tampered = await POST(
    request(tamperedId, { ...command, command: "cat ~/.ssh/id_rsa" }),
  );
  expect(tampered.status).toBe(403);
  expect(await tampered.json()).toEqual({ error: "Operation mismatch" });
  // A mismatch consumes the operation; the genuine digest cannot reclaim it.
  expect((await POST(request(tamperedId, command))).status).toBe(404);

  const validId = await authorizeDesktopOperation(
    "user-1",
    "desktop-1",
    command,
  );
  const browser = new Request(
    "http://localhost/api/desktop/authorized-operation",
    {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: JSON.stringify({
        id: validId,
        digest: desktopOperationDigest(command),
      }),
    },
  );
  expect((await POST(browser)).status).toBe(403);
  const valid = await POST(
    request(validId, { ...command, env: { A: "1", B: "2" } }),
  );
  expect(valid.status).toBe(200);
  expect(valid.headers.get("Cache-Control")).toBe("no-store");
  expect(await valid.json()).toEqual({ approved: true });
  expect((await POST(request(validId, command))).status).toBe(404);
  expect(mockRedis.getdelCount).toBe(4);

  expect(decisionEvents()).toEqual([
    decisionEvent({
      command_id: SAMPLED_COMMAND_ID,
      decision: "mismatch",
      sample_reason: "mismatch",
    }),
    decisionEvent({
      command_id: SAMPLED_COMMAND_ID,
      decision: "approved",
      sample_reason: "sampled",
    }),
  ]);
  const logged = decisionLines().join("\n");
  for (const secret of [
    tamperedId,
    validId,
    desktopOperationDigest(command),
    "printf safe",
    "id_rsa",
    "user-1",
    "desktop-1",
  ]) {
    expect(logged).not.toContain(secret);
  }
});

it("reports slow issuance or lookup for unsampled commands and skips fast ones", async () => {
  const command = { type: "command", commandId: UNSAMPLED_COMMAND_ID };
  const fastId = await authorizeDesktopOperation(
    "user-1",
    "desktop-1",
    command,
  );
  expect((await POST(request(fastId, command))).status).toBe(200);
  expect(decisionEvents()).toEqual([]);

  const oldId = await authorizeDesktopOperation("user-1", "desktop-1", command);
  mockClock.nowMs += 6000;
  expect((await POST(request(oldId, command))).status).toBe(200);

  const slowLookupId = await authorizeDesktopOperation(
    "user-1",
    "desktop-1",
    command,
  );
  mockRedis.lookupMs = 5000;
  expect((await POST(request(slowLookupId, command))).status).toBe(200);

  expect(decisionEvents()).toEqual([
    decisionEvent({
      command_id: UNSAMPLED_COMMAND_ID,
      decision: "approved",
      sample_reason: "slow",
      operation_age_ms: 6000,
    }),
    decisionEvent({
      command_id: UNSAMPLED_COMMAND_ID,
      decision: "approved",
      sample_reason: "slow",
      operation_age_ms: 5000,
      handler_elapsed_ms: 5000,
      lookup_elapsed_ms: 5000,
    }),
  ]);
});

describe("legacy or malformed diagnostic metadata", () => {
  const command = { type: "command", commandId: SAMPLED_COMMAND_ID };
  const valid = { version: 1, commandId: SAMPLED_COMMAND_ID, issuedAtMs: 1 };
  const cases: [string, () => Record<string, unknown>][] = [
    ["legacy record", () => ({})],
    ["unknown version", () => ({ diagnostic: { ...valid, version: 2 } })],
    [
      "uppercase command id",
      () => ({
        diagnostic: { ...valid, commandId: SAMPLED_COMMAND_ID.toUpperCase() },
      }),
    ],
    ["extra field", () => ({ diagnostic: { ...valid, path: "/private" } })],
    ["string issuance", () => ({ diagnostic: { ...valid, issuedAtMs: "1" } })],
    ["array metadata", () => ({ diagnostic: [valid] })],
    [
      "throwing metadata getter",
      () =>
        Object.defineProperty({}, "diagnostic", {
          enumerable: true,
          get: () => {
            throw new Error("getter");
          },
        }),
    ],
    [
      "command id getter",
      () => ({
        diagnostic: Object.defineProperty(
          { version: 1, issuedAtMs: 1 },
          "commandId",
          { enumerable: true, get: () => SAMPLED_COMMAND_ID },
        ),
      }),
    ],
  ];

  function store(id: string, extra: Record<string, unknown>) {
    mockEntries.set(
      `${KEY_PREFIX}${id}`,
      Object.assign(extra, {
        userId: "user-1",
        connectionId: "desktop-1",
        digest: desktopOperationDigest(command),
      }),
    );
  }

  it.each(cases)(
    "%s keeps approval, mismatch and consumption unchanged without logging",
    async (_name, metadata) => {
      store("a".repeat(64), metadata());
      store("b".repeat(64), metadata());

      const approved = await POST(request("a".repeat(64), command));
      expect(approved.status).toBe(200);
      expect(await approved.json()).toEqual({ approved: true });
      const mismatch = await POST(
        request("b".repeat(64), { ...command, command: "other" }),
      );
      expect(mismatch.status).toBe(403);
      expect((await POST(request("a".repeat(64), command))).status).toBe(404);
      expect(mockRedis.getdelCount).toBe(3);
      expect(decisionEvents()).toEqual([]);
    },
  );

  it("does not let valid metadata rescue an invalid stored operation", async () => {
    mockEntries.set(`${KEY_PREFIX}${"c".repeat(64)}`, {
      userId: "user-1",
      connectionId: "desktop-1",
      digest: "not-a-digest",
      diagnostic: valid,
    });
    expect((await POST(request("c".repeat(64), command))).status).toBe(404);
    expect(decisionEvents()).toEqual([]);
  });
});

it("keeps the decision when the log sink throws", async () => {
  info.mockImplementation(() => {
    throw new Error("sink unavailable");
  });
  const command = { type: "command", commandId: SAMPLED_COMMAND_ID };
  const approvedId = await authorizeDesktopOperation(
    "user-1",
    "desktop-1",
    command,
  );
  const approved = await POST(request(approvedId, command));
  expect(approved.status).toBe(200);
  expect(await approved.json()).toEqual({ approved: true });

  const mismatchId = await authorizeDesktopOperation(
    "user-1",
    "desktop-1",
    command,
  );
  const mismatch = await POST(
    request(mismatchId, { ...command, command: "other" }),
  );
  expect(mismatch.status).toBe(403);
  expect(await mismatch.json()).toEqual({ error: "Operation mismatch" });
  expect(info).toHaveBeenCalledTimes(2);
  expect((await POST(request(approvedId, command))).status).toBe(404);
});

it("rejects browser-origin, malformed, and unavailable requests without decision events", async () => {
  const command = { type: "command", commandId: SAMPLED_COMMAND_ID };
  const id = await authorizeDesktopOperation("user-1", "desktop-1", command);
  const post = (body: unknown, headers?: Record<string, string>) =>
    POST(
      new Request("http://localhost/api/desktop/authorized-operation", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  const digest = desktopOperationDigest(command);

  expect(
    (await post({ id, digest }, { "Sec-Fetch-Site": "same-origin" })).status,
  ).toBe(403);
  expect((await post({ id: id.toUpperCase(), digest })).status).toBe(400);
  expect((await post({ id, digest: digest.slice(1) })).status).toBe(400);
  expect(mockRedis.getdelCount).toBe(0);

  mockRedis.fail = true;
  const unavailable = await post({ id, digest });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ error: "Operation unavailable" });
  expect(decisionEvents()).toEqual([]);
});
