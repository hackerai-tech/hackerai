/** @jest-environment node */
jest.mock("@trigger.dev/sdk", () => ({
  schedules: { task: (definition: unknown) => definition },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  tasks: { trigger: jest.fn(async () => ({ id: "run_review" })) },
  idempotencyKeys: {
    create: jest.fn(
      async (key: string, options: { scope: string }) =>
        `${options.scope}:${key}`,
    ),
  },
}));
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

import { logger, tasks } from "@trigger.dev/sdk";
import fixture from "@/scripts/egress/tests/credentials.json";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { registerAttributedWorkspace } from "@/lib/cloud-network/egress-attribution";
import {
  ingestTelemetryBatch,
  telemetryBatchSchema,
  telemetryMinuteKey,
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
let zsets: Map<string, Map<string, number>>;
let redis: Record<string, jest.Mock>;
type ScoreMember = { score: number; member: string };
/** Key-value and sorted-set semantics of the Upstash calls the task uses. */
function fakeRedis() {
  store = new Map();
  zsets = new Map();
  const read = (key: string) => {
    const value = store.get(key);
    return value === undefined ? null : JSON.parse(value);
  };
  const zset = (key: string) => {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key)!;
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
    zmscore: jest.fn(async (key: string, members: string[]) =>
      members.map((member) => zset(key).get(member) ?? null),
    ),
    zcard: jest.fn(async (key: string) => zset(key).size),
    zadd: jest.fn(
      async (key: string, ...args: Array<ScoreMember | { nx?: boolean }>) => {
        const nx = !("member" in args[0]) && args[0].nx === true;
        let added = 0;
        for (const entry of args) {
          if (!("member" in entry)) continue;
          if (nx && zset(key).has(entry.member)) continue;
          if (!zset(key).has(entry.member)) added++;
          zset(key).set(entry.member, entry.score);
        }
        return added;
      },
    ),
    // Ascending by score, then member, as Redis orders ties.
    zrange: jest.fn(
      async (
        key: string,
        start: string | number,
        stop: number,
        options: { offset: number; count: number; withScores?: boolean },
      ) =>
        [...zset(key).entries()]
          .filter(
            ([, score]) =>
              (start === "-inf" || score >= Number(start)) && score <= stop,
          )
          .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
          .slice(options.offset, options.offset + options.count)
          .flatMap(([member, score]) =>
            options.withScores ? [member, score] : [member],
          ),
    ),
    zrem: jest.fn(async (key: string, ...members: string[]) => {
      let removed = 0;
      for (const member of members) if (zset(key).delete(member)) removed++;
      return removed;
    }),
  };
  jest.mocked(createRedisClient).mockReturnValue(redis as never);
}
const queued = () => [
  ...(zsets.get("egress-abuse-review:v1:dispatch-queue") ?? new Map()),
];

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
const ok = (promise: Promise<unknown>) =>
  expect(promise).resolves.toEqual({ status: "ok" });

const volumeWarnings = () =>
  jest
    .mocked(logger.warn)
    .mock.calls.filter(([message]) => message === "High connection volume");

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

it("warns with verified IDs without failing", async () => {
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

  await ok(runEgressBurstAlerts(at()));
  expect(volumeWarnings()).toEqual([
    [
      "High connection volume",
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
  expect(logger.error).not.toHaveBeenCalled();
});

it("warns about unattributed overflow without failing", async () => {
  await upload("us", MINUTE, [], { overflowConnections: 7 });
  await ok(runEgressBurstAlerts(at()));
  expect(volumeWarnings()).toEqual([
    [
      "High connection volume",
      {
        region: "us",
        minute: MINUTE,
        unattributed: true,
        connections: 7,
        threshold: 5,
      },
    ],
  ]);
});

it("deduplicates a logged minute and warns again for a new minute", async () => {
  await upload("us", MINUTE, [count(first, 9)]);
  // Concurrent runs both succeed; at worst the warning is duplicated.
  const results = await Promise.allSettled([
    runEgressBurstAlerts(at()),
    runEgressBurstAlerts(at()),
  ]);
  expect(results.map(({ status }) => status)).toEqual([
    "fulfilled",
    "fulfilled",
  ]);
  const afterConcurrent = volumeWarnings().length;
  expect(afterConcurrent).toBeGreaterThanOrEqual(1);
  expect(afterConcurrent).toBeLessThanOrEqual(2);

  // A minute later the window still holds it, but it is not logged again.
  await upload("eu", MINUTE + 1);
  await ok(runEgressBurstAlerts(at(MINUTE + 1)));
  expect(volumeWarnings()).toHaveLength(afterConcurrent);

  // A new minute for the same owner gets its own warning.
  await upload("us", MINUTE + 2, [count(first, 6)]);
  await upload("eu", MINUTE + 2);
  await ok(runEgressBurstAlerts(at(MINUTE + 2)));
  expect(volumeWarnings()).toHaveLength(afterConcurrent + 1);
  expect(volumeWarnings().at(-1)).toEqual([
    "High connection volume",
    expect.objectContaining({ minute: MINUTE + 2, connections: 6 }),
  ]);
});

it("logs the 20 largest candidates first and the rest next run", async () => {
  const owners = Array.from({ length: 25 }, (_, index) => ({
    owner: index.toString(16).padStart(32, "0"),
    workspace: "f".repeat(32),
    connections: 5 + index,
  }));
  await upload("us", MINUTE, owners);
  await ok(runEgressBurstAlerts(at()));
  const loggedCounts = () =>
    volumeWarnings().map(([, data]) => data?.connections);
  expect(loggedCounts()).toEqual(
    Array.from({ length: 20 }, (_, index) => 29 - index),
  );
  expect(logger.warn).toHaveBeenCalledWith(
    "High connection volume warnings deferred to the next run",
    { pending: 25, warned: 20 },
  );

  await ok(runEgressBurstAlerts(at()));
  await ok(runEgressBurstAlerts(at()));
  expect(loggedCounts()).toEqual(
    Array.from({ length: 25 }, (_, index) => 29 - index),
  );
});

it("does not mark a failed warning, and retries next run", async () => {
  await upload("us", MINUTE, [count(first, 5)]);
  jest.mocked(logger.warn).mockImplementationOnce(() => {
    throw new Error("log sink unavailable");
  });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: alert state could not be recorded",
  );
  expect([...store.keys()].some((key) => key.startsWith("egress-burst:"))).toBe(
    false,
  );
  await ok(runEgressBurstAlerts(at()));
  // The failed attempt is recorded by the mock too.
  expect(volumeWarnings()).toHaveLength(2);
});

it("fails on an uncertain mark after logging and tolerates one duplicate", async () => {
  await upload("us", MINUTE, [count(first, 5)]);
  const set = redis.set.getMockImplementation()!;
  redis.set.mockImplementation(async (key: string, ...rest: unknown[]) => {
    if (key.startsWith("egress-burst:")) throw new Error("timeout");
    return set(key, ...rest);
  });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: alert state could not be recorded",
  );
  redis.set.mockImplementation(set);
  await ok(runEgressBurstAlerts(at()));
  await ok(runEgressBurstAlerts(at()));
  // Logged again once after the failed mark, then deduplicated.
  expect(volumeWarnings()).toHaveLength(2);
});

it("evaluates a late upload while its minute is still in the window", async () => {
  await upload("us", MINUTE - 1);
  await ok(runEgressBurstAlerts(at()));
  expect(volumeWarnings()).toHaveLength(0);
  await upload("us", MINUTE, [count(first, 5)]);
  await ok(runEgressBurstAlerts(at(MINUTE + 1)));
  expect(volumeWarnings()).toHaveLength(1);
});

it("does not warn below the threshold or aggregate across regions", async () => {
  // Different regions are different proxies and never aggregated.
  await upload("us", MINUTE, [count(first, 4)]);
  await upload("eu", MINUTE - 1, [count(europe, 4)]);
  await ok(runEgressBurstAlerts(at()));
  expect(volumeWarnings()).toHaveLength(0);
});

it("fails on a missing collector heartbeat rather than reading it as zero", async () => {
  // US has uploaded nothing in the evaluated minutes; an older minute does not count.
  await upload("us", MINUTE - 5);
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: us collector heartbeat missing",
  );
  // The run log names the exact settled window that had no upload.
  const missing = jest
    .mocked(logger.warn)
    .mock.calls.filter(
      ([message]) => message === "Egress collector heartbeat missing",
    );
  expect(missing).toEqual([
    [
      "Egress collector heartbeat missing",
      {
        region: "us",
        firstMinute: MINUTE - 4,
        lastMinute: MINUTE,
        windowStart: new Date((MINUTE - 4) * 60_000).toISOString(),
        windowEnd: new Date((MINUTE + 1) * 60_000).toISOString(),
        scheduledAt: at().toISOString(),
      },
    ],
  ]);
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

it("fails for lost telemetry but still warns about high volume in that minute", async () => {
  await upload("us", MINUTE, [count(first, 9)], { droppedBatches: 1 });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.failures.map(({ kind }) => kind)).toEqual(["loss"]);
  expect(volumeWarnings()).toHaveLength(1);
});

it("fails when the registry cannot be read, and warns on recovery", async () => {
  await upload("us", MINUTE, [count(first, 5)]);
  const read = redis.mget.getMockImplementation()!;
  redis.mget.mockImplementation(async (...keys: string[]) => {
    if (keys[0].startsWith("egress-attribution:")) throw new Error("down");
    return read(...keys);
  });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: alert state could not be recorded",
  );
  expect(volumeWarnings()).toHaveLength(0);
  redis.mget.mockImplementation(read);
  await ok(runEgressBurstAlerts(at()));
  expect(volumeWarnings()).toHaveLength(1);
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
  await upload("us", MINUTE, [count(first, 9)]);
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: alert configuration is missing or invalid",
  );
  expect(redis.mget).not.toHaveBeenCalled();
});

describe("abuse review dispatch", () => {
  const trigger = () => jest.mocked(tasks.trigger);
  beforeEach(() => {
    process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED = "true";
    trigger().mockResolvedValue({ id: "run_review" } as never);
  });

  it("is off by default and still logs the warning", async () => {
    delete process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED;
    await upload("us", MINUTE, [count(first, 9)]);
    await ok(runEgressBurstAlerts(at()));
    expect(volumeWarnings()).toHaveLength(1);
    expect(trigger()).not.toHaveBeenCalled();
  });

  it("dispatches one delayed review per owner window with opaque references only", async () => {
    await upload("us", MINUTE, [count(first, 9)]);
    await ok(runEgressBurstAlerts(at()));
    expect(trigger()).toHaveBeenCalledTimes(1);
    const [id, payload, options] = trigger().mock.calls[0] as unknown as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(id).toBe("egress-abuse-review");
    expect(payload).toEqual({
      region: "us",
      owner: first.owner,
      minute: MINUTE,
    });
    // Global scope: a raw key would only dedupe within this one scheduled run.
    expect(options).toMatchObject({
      idempotencyKey: expect.stringMatching(
        /^global:egress-abuse-review:v1:us:/,
      ),
      delay: "10m",
    });
    expect(JSON.stringify(trigger().mock.calls)).not.toContain(first.userId);

    // Later runs and the next minute of the same window do not dispatch again.
    await ok(runEgressBurstAlerts(at()));
    await upload("eu", MINUTE + 1);
    await upload("us", MINUTE + 1, [count(first, 12)]);
    await ok(runEgressBurstAlerts(at(MINUTE + 1)));
    const sameWindow =
      Math.floor(MINUTE / 30) === Math.floor((MINUTE + 1) / 30);
    expect(trigger()).toHaveBeenCalledTimes(sameWindow ? 1 : 2);
  });

  it("never dispatches from overflow or incomplete minutes", async () => {
    await upload("us", MINUTE, [count(first, 9)], {
      complete: false,
      overflowConnections: 50,
    });
    const error = await failure(runEgressBurstAlerts(at()));
    expect(error.failures.map(({ kind }) => kind)).toEqual(["loss"]);
    expect(volumeWarnings()).toHaveLength(2);
    expect(trigger()).not.toHaveBeenCalled();
  });

  it("dispatches the review even when warning logging fails", async () => {
    await upload("us", MINUTE, [count(first, 9)]);
    jest.mocked(logger.warn).mockImplementationOnce(() => {
      throw new Error("log sink unavailable");
    });
    const error = await failure(runEgressBurstAlerts(at()));
    expect(error.failures.map(({ kind }) => kind)).toEqual(["state"]);
    expect(trigger()).toHaveBeenCalledTimes(1);
  });

  it("still dispatches a later region when logging a missing heartbeat throws", async () => {
    const minute = MINUTE - 1;
    await upload("eu", minute, [count(europe, 9)]);
    jest.mocked(logger.warn).mockImplementationOnce(() => {
      throw new Error("log sink unavailable");
    });

    const error = await failure(runEgressBurstAlerts(at()));
    expect(error.failures).toEqual([{ kind: "heartbeat", region: "us" }]);
    expect(trigger()).toHaveBeenCalledTimes(1);
    expect(trigger()).toHaveBeenCalledWith(
      "egress-abuse-review",
      { region: "eu", owner: europe.owner, minute },
      expect.anything(),
    );
  });

  it("reports a failed dispatch and retries it on the next run", async () => {
    await upload("us", MINUTE, [count(first, 9)]);
    trigger().mockRejectedValueOnce(new Error("trigger unavailable"));
    const error = await failure(runEgressBurstAlerts(at()));
    expect(error.message).toBe(
      "Egress attribution alert: abuse review could not be dispatched",
    );
    // The warning is independent of review dispatch.
    expect(volumeWarnings()).toHaveLength(1);
    await ok(runEgressBurstAlerts(at(MINUTE + 1)));
    expect(trigger()).toHaveBeenCalledTimes(2);
    await ok(runEgressBurstAlerts(at()));
    expect(trigger()).toHaveBeenCalledTimes(2);
    expect(volumeWarnings()).toHaveLength(1);
  });

  /** Collector heartbeats for a later run, with no new candidates. */
  const heartbeat = async (minute: number) => {
    await upload("us", minute);
    await upload("eu", minute);
  };
  const dispatchedMinutes = () =>
    trigger().mock.calls.map(
      ([, payload]) => (payload as unknown as { minute: number }).minute,
    );
  // MINUTE - 4 is the oldest minute a run at at(MINUTE) evaluates.
  const LAST_VISIBLE = MINUTE - 4;

  it.each(["write failure", "full queue"])(
    "replays an enqueue blocked by %s on the last alert minute without repeating the warning",
    async (reason) => {
      await upload("us", LAST_VISIBLE, [count(first, 9)]);
      if (reason === "write failure")
        redis.zadd.mockRejectedValueOnce(new Error("store down"));
      else redis.zcard.mockResolvedValueOnce(2_000);
      await failure(runEgressBurstAlerts(at()));
      expect(trigger()).not.toHaveBeenCalled();
      await heartbeat(MINUTE + 1);
      await ok(runEgressBurstAlerts(at(MINUTE + 1)));
      expect(dispatchedMinutes()).toEqual([LAST_VISIBLE]);
      expect(volumeWarnings()).toHaveLength(1);
    },
  );

  it("gives an untried entry a slot when older submissions keep failing", async () => {
    await upload(
      "us",
      MINUTE,
      Array.from({ length: 11 }, (_, index) => ({
        ...count(first, 9),
        owner: index.toString(16).padStart(32, "0"),
      })),
    );
    trigger().mockRejectedValue(new Error("trigger unavailable"));
    await failure(runEgressBurstAlerts(at()));
    expect(trigger()).toHaveBeenCalledTimes(10);
    await heartbeat(MINUTE + 1);
    await failure(runEgressBurstAlerts(at(MINUTE + 1)));
    const payload = trigger().mock.calls[10][1] as { owner: string };
    expect(payload.owner).toBe("a".padStart(32, "0"));
  });

  it("removes a stale queue entry with a dispatch mark without reporting expiry", async () => {
    await upload("us", MINUTE, [count(first, 9)]);
    redis.zrem.mockRejectedValueOnce(new Error("queue cleanup failed"));
    await failure(runEgressBurstAlerts(at()));
    expect(queued()).toHaveLength(1);
    await heartbeat(MINUTE + 31);
    await ok(runEgressBurstAlerts(at(MINUTE + 31)));
    expect(trigger()).toHaveBeenCalledTimes(1);
    expect(queued()).toEqual([]);
  });

  it("dispatches a capped review after its minute leaves the evaluation window", async () => {
    const owners = Array.from({ length: 11 }, (_, index) => ({
      owner: index.toString(16).padStart(32, "0"),
      workspace: "f".repeat(32),
      connections: 9,
    }));
    await upload("us", LAST_VISIBLE, owners);
    await ok(runEgressBurstAlerts(at()));
    expect(trigger()).toHaveBeenCalledTimes(10);
    expect(logger.warn).toHaveBeenCalledWith(
      "Egress abuse reviews deferred to the next run",
      { pending: 11, dispatched: 10 },
    );
    expect(queued()).toHaveLength(1);

    // The next run no longer reads that minute and has no new candidates.
    await heartbeat(MINUTE + 1);
    await ok(runEgressBurstAlerts(at(MINUTE + 1)));
    expect(trigger()).toHaveBeenCalledTimes(11);
    expect(dispatchedMinutes()).toEqual(Array(11).fill(LAST_VISIBLE));
    expect(
      new Set(
        trigger().mock.calls.map(
          ([, payload]) => (payload as unknown as { owner: string }).owner,
        ),
      ).size,
    ).toBe(11);
    expect(queued()).toEqual([]);
    // The review rechecks a minute whose telemetry is still retained.
    expect(store.has(telemetryMinuteKey("us", LAST_VISIBLE))).toBe(true);
  });

  it("retries a failed dispatch after its minute leaves the evaluation window", async () => {
    await upload("us", LAST_VISIBLE, [count(first, 9)]);
    trigger().mockRejectedValueOnce(new Error("trigger unavailable"));
    const error = await failure(runEgressBurstAlerts(at()));
    expect(error.failures.map(({ kind }) => kind)).toEqual(["review"]);

    await heartbeat(MINUTE + 1);
    await ok(runEgressBurstAlerts(at(MINUTE + 1)));
    expect(dispatchedMinutes()).toEqual([LAST_VISIBLE, LAST_VISIBLE]);
    // Both attempts carry the case's one global idempotency key.
    const keys = trigger().mock.calls.map(
      ([, , options]) =>
        (options as unknown as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
    await ok(runEgressBurstAlerts(at(MINUTE + 1)));
    expect(trigger()).toHaveBeenCalledTimes(2);
    expect(queued()).toEqual([]);
  });

  it.each(["zadd", "zrange"])(
    "fails the run when the review queue %s is unavailable, and recovers",
    async (method) => {
      await upload("us", MINUTE, [count(first, 9)]);
      redis[method].mockRejectedValueOnce(new Error("store down"));
      const error = await failure(runEgressBurstAlerts(at()));
      expect(error.message).toBe(
        "Egress attribution alert: abuse review could not be dispatched",
      );
      // The warning is independent of review dispatch.
      expect(volumeWarnings()).toHaveLength(1);
      expect(trigger()).not.toHaveBeenCalled();
      await ok(runEgressBurstAlerts(at()));
      expect(trigger()).toHaveBeenCalledTimes(1);
    },
  );

  it("reports and removes expired reviews even beyond the first queue page", async () => {
    await upload(
      "us",
      MINUTE,
      Array.from({ length: 51 }, (_, index) => ({
        ...count(first, 9),
        owner: index.toString(16).padStart(32, "0"),
      })),
    );
    trigger().mockRejectedValue(new Error("trigger unavailable"));
    await failure(runEgressBurstAlerts(at()));
    expect(queued()).toHaveLength(51);

    await heartbeat(MINUTE + 31);
    const error = await failure(runEgressBurstAlerts(at(MINUTE + 31)));
    expect(error.failures.map(({ kind }) => kind)).toEqual(["review"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Egress abuse reviews expired before dispatch",
      { expired: 51 },
    );
    expect(trigger()).toHaveBeenCalledTimes(10);
    expect(queued()).toEqual([]);
    await ok(runEgressBurstAlerts(at(MINUTE + 31)));
  });

  it("still warns about high volume when the review toggle is invalid", async () => {
    process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED = "yes";
    await upload("us", MINUTE, [count(first, 9)]);
    await ok(runEgressBurstAlerts(at()));
    expect(volumeWarnings()).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Invalid egress abuse review configuration",
    );
    expect(trigger()).not.toHaveBeenCalled();
  });
});

it("is scheduled every minute in Production only, without retries", () => {
  expect(egressBurstAlertsTask).toMatchObject({
    id: "egress-burst-alerts",
    cron: { pattern: "* * * * *", environments: ["PRODUCTION"] },
    retry: { maxAttempts: 1 },
  });
});
