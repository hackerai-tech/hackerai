/** @jest-environment node */
jest.mock("@trigger.dev/sdk", () => ({
  schedules: { task: (definition: unknown) => definition },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

import { logger } from "@trigger.dev/sdk";
import fixture from "@/scripts/egress/tests/credentials.json";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { registerAttributedWorkspace } from "@/lib/cloud-network/egress-attribution";
import {
  ingestTelemetryBatch,
  telemetryBatchSchema,
} from "@/lib/cloud-network/egress-telemetry";
import {
  EgressBurstAlertError,
  egressBurstAlertsTask,
  runEgressBurstAlerts,
} from "../egress-burst-alerts";

const [first, second, europe] = fixture.vectors;
const MINUTE = 30_000_000;
/** Runs two minutes after MINUTE, so MINUTE is the latest settled window. */
const at = (minute = MINUTE) => new Date((minute + 2) * 60_000);
const originalEnv = process.env;
let store: Map<string, string>;
let redis: Record<string, jest.Mock>;

function fakeRedis() {
  store = new Map();
  const read = (key: string) => {
    const value = store.get(key);
    return value === undefined ? null : JSON.parse(value);
  };
  redis = {
    set: jest.fn(
      async (key: string, value: string, opts?: { nx?: boolean }) => {
        if (opts?.nx && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
    ),
    get: jest.fn(async (key: string) => read(key)),
    mget: jest.fn(async (...keys: string[]) => keys.map(read)),
    expire: jest.fn(async () => 1),
  };
  jest.mocked(createRedisClient).mockReturnValue(redis as never);
}

type Count = { owner: string; workspace: string; connections: number };
/** Through the real ingestion path, as the route stores collector uploads. */
async function upload(
  region: "us" | "eu",
  minute: number,
  counts: Count[] = [],
  extra: Partial<Record<string, unknown>> = {},
) {
  const batch = telemetryBatchSchema.parse({
    version: 1,
    region,
    minute,
    complete: true,
    droppedEvents: 0,
    droppedBatches: 0,
    overflowConnections: 0,
    counts,
    ...extra,
  });
  const body = Buffer.from(JSON.stringify(batch));
  expect(
    await ingestTelemetryBatch(redis as never, batch, body, minute * 60_000),
  ).toBe("accepted");
}
const count = (vector: typeof first, connections: number) => ({
  owner: vector.owner,
  workspace: vector.workspace,
  connections,
});
const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(EgressBurstAlertError);
  return error as EgressBurstAlertError;
};

beforeEach(async () => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    E2B_EGRESS_BURST_ALERTS_ENABLED: "true",
    E2B_EGRESS_BURST_THRESHOLD: "5",
  };
  fakeRedis();
  // Both collectors are alive unless a test says otherwise.
  await upload("eu", MINUTE);
});
afterAll(() => {
  process.env = originalEnv;
});

it("alerts on one owner's aggregate across workspaces with verified IDs only in logs", async () => {
  await registerAttributedWorkspace("us", first, first.userId, first.sandboxId);
  // Registered to someone else: never reported as this owner's sandbox.
  store.set(
    `egress-attribution:v1:us:workspace:${second.workspace}`,
    JSON.stringify({
      userId: "user_other",
      sandboxId: "foreign",
      owner: first.owner,
    }),
  );
  const quiet = {
    owner: "a".repeat(32),
    workspace: "b".repeat(32),
    connections: 4,
  };
  // 3 + 2 crosses the threshold; neither workspace does alone.
  await upload("us", MINUTE, [count(first, 3), count(second, 2), quiet]);

  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    `Egress attribution alert: us connection burst for owner ${first.owner}`,
  );
  expect(error.message).not.toContain(first.userId);
  expect(error.message).not.toContain(first.sandboxId);
  expect(jest.mocked(logger.error).mock.calls).toEqual([
    [
      "Egress connection burst",
      {
        region: "us",
        minute: MINUTE,
        ownerRef: first.owner,
        userId: first.userId,
        sandboxIds: [first.sandboxId],
        unverifiedWorkspaces: 1,
        workspaces: 2,
        connections: 5,
        threshold: 5,
      },
    ],
  ]);
});

const burstLogs = () =>
  jest
    .mocked(logger.error)
    .mock.calls.filter(([message]) => message === "Egress connection burst");

it("fails every run while a burst is in the window and logs its details once", async () => {
  await upload("us", MINUTE, [count(first, 9)]);
  // Concurrent runs both fail; at worst the detailed log is duplicated.
  const results = await Promise.allSettled([
    runEgressBurstAlerts(at()),
    runEgressBurstAlerts(at()),
  ]);
  expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  const afterConcurrent = burstLogs().length;
  expect(afterConcurrent).toBeGreaterThanOrEqual(1);
  expect(afterConcurrent).toBeLessThanOrEqual(2);

  // A minute later the window still holds it: the run fails again (at least
  // once delivery) but the detailed log is not repeated.
  await upload("eu", MINUTE + 1);
  const again = await failure(runEgressBurstAlerts(at(MINUTE + 1)));
  expect(again.message).toContain(first.owner);
  expect(burstLogs()).toHaveLength(afterConcurrent);

  // Once the minute leaves the window, the alert clears.
  for (let minute = MINUTE + 2; minute <= MINUTE + 5; minute++)
    await upload("eu", minute);
  await upload("us", MINUTE + 5);
  await expect(runEgressBurstAlerts(at(MINUTE + 5))).resolves.toEqual({
    status: "ok",
  });

  // A new burst window for the same owner is logged again.
  await upload("us", MINUTE + 6, [count(first, 6)]);
  await upload("eu", MINUTE + 6);
  await failure(runEgressBurstAlerts(at(MINUTE + 6)));
  expect(burstLogs()).toHaveLength(afterConcurrent + 1);
});

it("fails for every burst but defers logs past the per-run cap to later runs", async () => {
  const owners = Array.from({ length: 25 }, (_, index) => ({
    owner: index.toString(16).padStart(32, "0"),
    workspace: "f".repeat(32),
    connections: 5 + index,
  }));
  await upload("us", MINUTE, owners);
  const error = await failure(runEgressBurstAlerts(at()));
  // Every burst fails the run, even those whose details wait for a later run.
  expect(error.failures.filter(({ kind }) => kind === "burst")).toHaveLength(
    25,
  );
  expect(error.message).toMatch(/; and 5 more$/);
  expect(burstLogs()).toHaveLength(20);
  // The largest bursts are logged first.
  expect(burstLogs().map(([, fields]) => fields.connections)).toEqual(
    Array.from({ length: 20 }, (_, index) => 29 - index),
  );
  expect(logger.warn).toHaveBeenCalledWith(
    "Egress burst logs deferred to the next run",
    { pending: 25, logged: 20 },
  );

  // The next run logs the five that were deferred, not the first twenty again.
  await failure(runEgressBurstAlerts(at()));
  expect(burstLogs()).toHaveLength(25);
  expect(new Set(burstLogs().map(([, fields]) => fields.ownerRef)).size).toBe(
    25,
  );
});

it("does not mark a burst logged when the log fails, and retries it next run", async () => {
  await upload("us", MINUTE, [count(first, 5)]);
  jest.mocked(logger.error).mockImplementationOnce(() => {
    throw new Error("log sink unavailable");
  });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toContain("alert state could not be recorded");
  expect(error.message).toContain(first.owner);
  expect([...store.keys()].some((key) => key.startsWith("egress-burst:"))).toBe(
    false,
  );
  await failure(runEgressBurstAlerts(at()));
  expect(burstLogs()).toHaveLength(2);
});

it("tolerates a duplicate log after an uncertain mark", async () => {
  await upload("us", MINUTE, [count(first, 5)]);
  const set = redis.set.getMockImplementation()!;
  redis.set.mockImplementation(async (key: string, ...rest: unknown[]) => {
    if (key.startsWith("egress-burst:")) throw new Error("timeout");
    return set(key, ...rest);
  });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toContain("alert state could not be recorded");
  redis.set.mockImplementation(set);
  await failure(runEgressBurstAlerts(at()));
  await failure(runEgressBurstAlerts(at()));
  // Logged again once after the failed mark, then never again.
  expect(burstLogs()).toHaveLength(2);
});

it("evaluates a late upload while its minute is still in the window", async () => {
  await upload("us", MINUTE - 1);
  await expect(runEgressBurstAlerts(at())).resolves.toEqual({ status: "ok" });
  await upload("us", MINUTE, [count(first, 5)]);
  await failure(runEgressBurstAlerts(at(MINUTE + 1)));
});

it("does not alert below the threshold or across regions", async () => {
  // Different regions are different proxies and never aggregated.
  await upload("us", MINUTE, [count(first, 4)]);
  await upload("eu", MINUTE - 1, [count(europe, 4)]);
  await expect(runEgressBurstAlerts(at())).resolves.toEqual({ status: "ok" });
  expect(logger.error).not.toHaveBeenCalled();
});

it("fails on a missing collector heartbeat rather than reading it as zero", async () => {
  // US has uploaded nothing in the evaluated minutes; an older minute does not count.
  await upload("us", MINUTE - 5);
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: us collector heartbeat missing",
  );
  // Not deduplicated: every run fails while the condition lasts.
  await failure(runEgressBurstAlerts(at()));
});

it("alerts on an incomplete minute even when the missing event count is unknown", async () => {
  // Startup and a failed journal stream both produce this shape. Neither
  // proves zero traffic, so a continuously broken stream must keep alerting.
  await upload("us", MINUTE, [], { complete: false });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: us collector reported lost telemetry",
  );
  await failure(runEgressBurstAlerts(at()));
  expect(logger.warn).toHaveBeenCalledWith("Egress telemetry incomplete", {
    region: "us",
    minute: MINUTE,
    complete: false,
    droppedEvents: 0,
    droppedBatches: 0,
  });
});

it.each([
  ["dropped events", { complete: false, droppedEvents: 2 }],
  ["dropped batches", { droppedBatches: 1 }],
])("fails on reported %s", async (_label, extra) => {
  await upload("us", MINUTE, [], extra);
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: us collector reported lost telemetry",
  );
});

it("fails on overflow that could hide a burst", async () => {
  await upload("us", MINUTE, [], { overflowConnections: 7 });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: us unattributed overflow at or over threshold",
  );
  expect(logger.error).toHaveBeenCalledWith(
    "Egress unattributed overflow over threshold",
    { region: "us", minute: MINUTE, connections: 7, threshold: 5 },
  );
});

it("still fails for a burst when the registry cannot be read, and logs it later", async () => {
  await upload("us", MINUTE, [count(first, 5)]);
  const read = redis.mget.getMockImplementation()!;
  redis.mget.mockImplementation(async (...keys: string[]) => {
    if (keys[0].startsWith("egress-attribution:")) throw new Error("down");
    return read(...keys);
  });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: alert state could not be recorded; " +
      `us connection burst for owner ${first.owner}`,
  );
  expect(burstLogs()).toHaveLength(0);
  redis.mget.mockImplementation(read);
  expect((await failure(runEgressBurstAlerts(at()))).message).toContain(
    first.owner,
  );
  expect(burstLogs()).toHaveLength(1);
});

it.each([undefined, "", "false"])(
  "is off for %p without reading the threshold or store",
  async (enabled) => {
    if (enabled === undefined)
      delete process.env.E2B_EGRESS_BURST_ALERTS_ENABLED;
    else process.env.E2B_EGRESS_BURST_ALERTS_ENABLED = enabled;
    delete process.env.E2B_EGRESS_BURST_THRESHOLD;
    jest.mocked(createRedisClient).mockClear();
    await expect(runEgressBurstAlerts(at())).resolves.toEqual({
      status: "disabled",
    });
    expect(createRedisClient).not.toHaveBeenCalled();
  },
);

it.each<[string, Record<string, string | undefined>]>([
  ["an invalid toggle", { E2B_EGRESS_BURST_ALERTS_ENABLED: "TRUE" }],
  ["no explicit threshold", { E2B_EGRESS_BURST_THRESHOLD: undefined }],
  ["a zero threshold", { E2B_EGRESS_BURST_THRESHOLD: "0" }],
  ["a fractional threshold", { E2B_EGRESS_BURST_THRESHOLD: "2.5" }],
])("fails with a configuration error on %s", async (_label, overrides) => {
  for (const [name, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: alert configuration is missing or invalid",
  );
  expect(redis.mget).not.toHaveBeenCalled();
});

it("is scheduled every minute in Production only, without retries", () => {
  expect(egressBurstAlertsTask).toMatchObject({
    id: "egress-burst-alerts",
    cron: { pattern: "* * * * *", environments: ["PRODUCTION"] },
    retry: { maxAttempts: 1 },
  });
});
