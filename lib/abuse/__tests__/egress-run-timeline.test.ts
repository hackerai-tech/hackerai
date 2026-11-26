/** @jest-environment node */
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  MAX_TIMELINE_WORKSPACES,
  readRunTimeline,
  recordRunTimelineAcquisition,
  runTimelineShadowGate,
} from "../egress-run-timeline";

// The scripts run against real Redis in
// scripts/tests/egress-run-timeline.integration.ts; these cover the switches
// and what happens when the store misbehaves.
const flush = () => new Promise((resolve) => setImmediate(resolve));
const originalEnv = process.env;
const acquisition = {
  region: "us" as const,
  userId: "user_1",
  sandboxId: "sbx_1",
  chatId: "chat_1",
  runId: "run_1",
};
const burst = { burstStart: 1_000_000, burstEnd: 1_060_000 };
const readFor = (sandboxIds: string[]) =>
  readRunTimeline({ region: "us", userId: "user_1", sandboxIds, ...burst });
let redis: { eval: jest.Mock };

beforeEach(() => {
  process.env = {
    ...originalEnv,
    E2B_EGRESS_ABUSE_REVIEW_ENABLED: "true",
    E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED: "true",
  };
  redis = { eval: jest.fn(async () => [[], ""]) };
  jest
    .mocked(createRedisClient)
    .mockReset()
    .mockReturnValue(redis as never);
});
afterEach(() => jest.useRealTimers());
afterAll(() => {
  process.env = originalEnv;
});

it.each([
  [undefined, "off"],
  ["false", "off"],
  ["true", "on"],
  ["1", "invalid"],
])("parses the shadow switch %p as %s", (value, expected) => {
  expect(
    runTimelineShadowGate({
      E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED: value,
    } as never),
  ).toBe(expected);
});

it.each([
  "E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED",
  "E2B_EGRESS_ABUSE_REVIEW_ENABLED",
])("neither records nor reads without %s", async (name) => {
  delete process.env[name];
  recordRunTimelineAcquisition(acquisition);
  await expect(readFor(["sbx_1"])).resolves.toMatchObject({
    summary: { status: "disabled" },
  });
  await flush();
  expect(createRedisClient).not.toHaveBeenCalled();
});

it("never throws into or waits on an acquisition", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.mocked(createRedisClient).mockImplementationOnce(() => {
    throw new Error("misconfigured");
  });
  expect(() => recordRunTimelineAcquisition(acquisition)).not.toThrow();
  redis.eval.mockRejectedValueOnce(new Error("store down"));
  expect(recordRunTimelineAcquisition(acquisition)).toBeUndefined();
  await flush();
  // Only a closed event name is logged.
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).toContain("egress_run_timeline_record_unavailable");
  for (const raw of Object.values(acquisition))
    expect(logged).not.toContain(raw);
  warn.mockRestore();
});

it("reports a read that exceeds its budget as unavailable", async () => {
  jest.useFakeTimers();
  redis.eval.mockReturnValue(new Promise(() => {}));
  const read = readFor(["sbx_1"]);
  await jest.advanceTimersByTimeAsync(1_500);
  await expect(read).resolves.toMatchObject({
    summary: { status: "unavailable" },
  });
});

it("labels a partly unreadable burst instead of narrowing it", async () => {
  redis.eval
    .mockResolvedValueOnce([["p|chat_1|run_1|1000", "1000"], ""])
    .mockRejectedValueOnce(new Error("store down"));
  const read = await readFor(["sbx_1", "sbx_2"]);
  expect(read.summary).toMatchObject({
    status: "read",
    assessment: "incomplete",
    parents: 1,
    workspaces: 1,
    limitations: ["workspace_unavailable"],
  });
  expect(read.lists({ kind: "parent", chatId: "chat_1", runId: "run_1" })).toBe(
    true,
  );
  expect(
    read.lists({ kind: "subagent", chatId: "chat_1", runId: "run_1" }),
  ).toBe(false);
});

it("reads a bounded number of workspaces and says so", async () => {
  const sandboxIds = Array.from(
    { length: MAX_TIMELINE_WORKSPACES + 2 },
    (_, index) => `sbx_${index}`,
  );
  await expect(readFor(sandboxIds)).resolves.toMatchObject({
    summary: {
      assessment: "incomplete",
      workspaces: MAX_TIMELINE_WORKSPACES,
      limitations: ["workspaces_capped"],
    },
  });
  expect(redis.eval).toHaveBeenCalledTimes(MAX_TIMELINE_WORKSPACES);
});

it("treats a malformed reply as an unreadable record", async () => {
  redis.eval.mockResolvedValueOnce("OK");
  await expect(readFor(["sbx_1"])).resolves.toMatchObject({
    summary: { assessment: "incomplete", limitations: ["invalid_record"] },
  });
});

it("keeps recorded candidates when the Redis client decodes an eviction timestamp as a number", async () => {
  redis.eval.mockResolvedValueOnce([["p|chat_1|run_1|1000", 1000], 1000]);
  const read = await readFor(["sbx_1"]);
  expect(read.summary).toMatchObject({
    status: "read",
    assessment: "incomplete",
    parents: 1,
    limitations: ["evicted_in_window"],
  });
  expect(read.lists({ kind: "parent", chatId: "chat_1", runId: "run_1" })).toBe(
    true,
  );
});
