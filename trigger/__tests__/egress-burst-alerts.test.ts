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
/** MINUTE as the notification shows it. */
const MINUTE_UTC = "2027-01-15T08:00Z";
/** Runs two minutes after MINUTE, so MINUTE is the latest settled window. */
const at = (minute = MINUTE) => new Date((minute + 2) * 60_000);
const originalEnv = process.env;
/** Reserved .test domain; fetch is mocked so nothing is ever sent. */
const WEBHOOK = "https://hooks.example.test/services/T0/B0/webhook-secret";
let store: Map<string, string>;
let zsets: Map<string, Map<string, number>>;
let redis: Record<string, jest.Mock>;
let fetchMock: jest.SpiedFunction<typeof fetch>;
const accepted = async () => new Response("ok", { status: 200 });

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

/** The text of every webhook message sent, in order. */
const sent = () =>
  fetchMock.mock.calls.map(
    ([, init]) => JSON.parse(String(init?.body)) as { text: string },
  );
const lines = (index: number) => sent()[index].text.split("\n").slice(1);
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
    E2B_EGRESS_BURST_NOTIFICATION_URL: WEBHOOK,
  };
  fakeRedis();
  fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(accepted);
  // Both collectors are alive unless a test says otherwise.
  await upload("eu", MINUTE);
});
afterEach(() => {
  fetchMock.mockRestore();
});
afterAll(() => {
  process.env = originalEnv;
});

it("warns with verified IDs and notifies with the opaque owner only, without failing", async () => {
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

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(WEBHOOK);
  expect(init).toMatchObject({
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
  expect(sent()).toEqual([
    {
      text:
        "High connection volume\n" +
        `us ${MINUTE_UTC} owner ${first.owner}: 5 connections (threshold 5)`,
    },
  ]);
  const body = String(init?.body);
  for (const raw of [first.userId, first.sandboxId, "user_other", "foreign"])
    expect(body).not.toContain(raw);
});

it("notifies unattributed overflow without failing", async () => {
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
  expect(lines(0)).toEqual([
    `us ${MINUTE_UTC} unattributed: 7 connections (threshold 5)`,
  ]);
});

it("notifies a minute once while it stays in the window, and a new minute again", async () => {
  await upload("us", MINUTE, [count(first, 9)]);
  // Concurrent runs both succeed; at worst the notification is duplicated.
  const results = await Promise.allSettled([
    runEgressBurstAlerts(at()),
    runEgressBurstAlerts(at()),
  ]);
  expect(results.map(({ status }) => status)).toEqual([
    "fulfilled",
    "fulfilled",
  ]);
  const afterConcurrent = fetchMock.mock.calls.length;
  expect(afterConcurrent).toBeGreaterThanOrEqual(1);
  expect(afterConcurrent).toBeLessThanOrEqual(2);

  // A minute later the window still holds it, but it is not sent again.
  await upload("eu", MINUTE + 1);
  await ok(runEgressBurstAlerts(at(MINUTE + 1)));
  expect(fetchMock).toHaveBeenCalledTimes(afterConcurrent);
  expect(volumeWarnings()).toHaveLength(afterConcurrent);

  // A new minute for the same owner is notified again.
  await upload("us", MINUTE + 2, [count(first, 6)]);
  await upload("eu", MINUTE + 2);
  await ok(runEgressBurstAlerts(at(MINUTE + 2)));
  expect(fetchMock).toHaveBeenCalledTimes(afterConcurrent + 1);
  expect(lines(afterConcurrent)).toEqual([
    `us 2027-01-15T08:02Z owner ${first.owner}: 6 connections (threshold 5)`,
  ]);
});

it("sends one message for at most 20 candidates per run and the rest next run", async () => {
  const owners = Array.from({ length: 25 }, (_, index) => ({
    owner: index.toString(16).padStart(32, "0"),
    workspace: "f".repeat(32),
    connections: 5 + index,
  }));
  await upload("us", MINUTE, owners);
  await ok(runEgressBurstAlerts(at()));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // The largest are sent first.
  expect(
    lines(0).map((line) => Number(line.split(": ")[1].split(" ")[0])),
  ).toEqual(Array.from({ length: 20 }, (_, index) => 29 - index));
  expect(volumeWarnings()).toHaveLength(20);
  expect(logger.warn).toHaveBeenCalledWith(
    "High connection volume notifications deferred to the next run",
    { pending: 25, notified: 20 },
  );

  // The next run sends the five deferred, not the first twenty again.
  await ok(runEgressBurstAlerts(at()));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(lines(1)).toHaveLength(5);
  expect(
    new Set([...lines(0), ...lines(1)].map((line) => line.split(": ")[0])).size,
  ).toBe(25);
  await ok(runEgressBurstAlerts(at()));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

describe("failed delivery", () => {
  it.each<[string, () => Promise<Response>]>([
    ["a server error", async () => new Response(WEBHOOK, { status: 500 })],
    ["a rejected request", async () => new Response(WEBHOOK, { status: 403 })],
    [
      "an unfollowed redirect",
      async () =>
        new Response(null, { status: 302, headers: { location: WEBHOOK } }),
    ],
    [
      "a network error",
      async () => {
        throw new TypeError(`fetch failed: ${WEBHOOK}`);
      },
    ],
    [
      "a timeout",
      async () => {
        throw new DOMException(`timed out: ${WEBHOOK}`, "TimeoutError");
      },
    ],
  ])(
    "fails the run on %s without exposing the URL, and retries next run",
    async (_label, response) => {
      await upload("us", MINUTE, [count(first, 9)]);
      fetchMock.mockImplementationOnce(response);
      const error = await failure(runEgressBurstAlerts(at()));
      expect(error.message).toBe(
        "Egress attribution alert: High connection volume notification could not be delivered",
      );
      expect(error.message).not.toContain(first.owner);
      const logged = JSON.stringify([
        jest.mocked(logger.warn).mock.calls,
        jest.mocked(logger.error).mock.calls,
        jest.mocked(logger.info).mock.calls,
      ]);
      expect(logged).not.toContain("hooks.example.test");
      expect(logged).not.toContain("webhook-secret");

      // Not marked: the next scheduled run sends it, then it is done.
      await ok(runEgressBurstAlerts(at()));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(lines(1)).toEqual(lines(0));
      await ok(runEgressBurstAlerts(at()));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});

it("does not notify or mark when the warning fails, and retries next run", async () => {
  await upload("us", MINUTE, [count(first, 5)]);
  jest.mocked(logger.warn).mockImplementationOnce(() => {
    throw new Error("log sink unavailable");
  });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.message).toBe(
    "Egress attribution alert: alert state could not be recorded",
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect([...store.keys()].some((key) => key.startsWith("egress-burst:"))).toBe(
    false,
  );
  await ok(runEgressBurstAlerts(at()));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // The failed attempt is recorded by the mock too.
  expect(volumeWarnings()).toHaveLength(2);
});

it("fails on an uncertain mark after delivery and tolerates one duplicate", async () => {
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
  // Sent again once after the failed mark, then never again.
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("evaluates a late upload while its minute is still in the window", async () => {
  await upload("us", MINUTE - 1);
  await ok(runEgressBurstAlerts(at()));
  expect(fetchMock).not.toHaveBeenCalled();
  await upload("us", MINUTE, [count(first, 5)]);
  await ok(runEgressBurstAlerts(at(MINUTE + 1)));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not warn or notify below the threshold or across regions", async () => {
  // Different regions are different proxies and never aggregated.
  await upload("us", MINUTE, [count(first, 4)]);
  await upload("eu", MINUTE - 1, [count(europe, 4)]);
  await ok(runEgressBurstAlerts(at()));
  expect(volumeWarnings()).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
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

it("fails for lost telemetry but still notifies high volume in that minute", async () => {
  await upload("us", MINUTE, [count(first, 9)], { droppedBatches: 1 });
  const error = await failure(runEgressBurstAlerts(at()));
  expect(error.failures.map(({ kind }) => kind)).toEqual(["loss"]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("fails when the registry cannot be read, and notifies later", async () => {
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
  expect(fetchMock).not.toHaveBeenCalled();
  redis.mget.mockImplementation(read);
  await ok(runEgressBurstAlerts(at()));
  expect(volumeWarnings()).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([undefined, "", "false"])(
  "is off for %p without reading the threshold, URL or store",
  async (enabled) => {
    if (enabled === undefined)
      delete process.env.E2B_EGRESS_BURST_ALERTS_ENABLED;
    else process.env.E2B_EGRESS_BURST_ALERTS_ENABLED = enabled;
    delete process.env.E2B_EGRESS_BURST_THRESHOLD;
    delete process.env.E2B_EGRESS_BURST_NOTIFICATION_URL;
    jest.mocked(createRedisClient).mockClear();
    await expect(runEgressBurstAlerts(at())).resolves.toEqual({
      status: "disabled",
    });
    expect(createRedisClient).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each<[string, Record<string, string | undefined>]>([
  ["an invalid toggle", { E2B_EGRESS_BURST_ALERTS_ENABLED: "TRUE" }],
  ["no explicit threshold", { E2B_EGRESS_BURST_THRESHOLD: undefined }],
  ["a zero threshold", { E2B_EGRESS_BURST_THRESHOLD: "0" }],
  ["a fractional threshold", { E2B_EGRESS_BURST_THRESHOLD: "2.5" }],
  ["no notification URL", { E2B_EGRESS_BURST_NOTIFICATION_URL: undefined }],
  ["an empty notification URL", { E2B_EGRESS_BURST_NOTIFICATION_URL: "" }],
  [
    "a plain HTTP notification URL",
    { E2B_EGRESS_BURST_NOTIFICATION_URL: WEBHOOK.replace("https", "http") },
  ],
  [
    "a notification URL with credentials",
    {
      E2B_EGRESS_BURST_NOTIFICATION_URL: WEBHOOK.replace(
        "https://",
        "https://user:pass@",
      ),
    },
  ],
  [
    "a notification URL with a fragment",
    { E2B_EGRESS_BURST_NOTIFICATION_URL: `${WEBHOOK}#` },
  ],
  [
    "a malformed notification URL",
    { E2B_EGRESS_BURST_NOTIFICATION_URL: "hooks.example.test/webhook-secret" },
  ],
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
  expect(fetchMock).not.toHaveBeenCalled();
});

describe("abuse review dispatch", () => {
  const trigger = () => jest.mocked(tasks.trigger);
  beforeEach(() => {
    process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED = "true";
    trigger().mockResolvedValue({ id: "run_review" } as never);
  });

  it("is off by default and leaves notification unchanged", async () => {
    delete process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED;
    await upload("us", MINUTE, [count(first, 9)]);
    await ok(runEgressBurstAlerts(at()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(lines(0)).toHaveLength(2);
    expect(trigger()).not.toHaveBeenCalled();
  });

  it("dispatches the review even when notification delivery fails", async () => {
    await upload("us", MINUTE, [count(first, 9)]);
    fetchMock.mockImplementationOnce(
      async () => new Response(null, { status: 503 }),
    );
    const error = await failure(runEgressBurstAlerts(at()));
    expect(error.failures.map(({ kind }) => kind)).toEqual(["notification"]);
    expect(trigger()).toHaveBeenCalledTimes(1);
  });

  it("reports a failed dispatch and retries it on the next run", async () => {
    await upload("us", MINUTE, [count(first, 9)]);
    trigger().mockRejectedValueOnce(new Error("trigger unavailable"));
    const error = await failure(runEgressBurstAlerts(at()));
    expect(error.message).toBe(
      "Egress attribution alert: abuse review could not be dispatched",
    );
    // Notification is independent of review dispatch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await ok(runEgressBurstAlerts(at(MINUTE + 1)));
    expect(trigger()).toHaveBeenCalledTimes(2);
    await ok(runEgressBurstAlerts(at()));
    expect(trigger()).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    "replays an enqueue blocked by %s on the last alert minute without re-notifying",
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
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
      // Notification is independent of review dispatch.
      expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("leaves notification working when the review toggle is invalid", async () => {
    process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED = "yes";
    await upload("us", MINUTE, [count(first, 9)]);
    await ok(runEgressBurstAlerts(at()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
