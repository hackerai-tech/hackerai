import { createHash } from "node:crypto";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import {
  ACQUISITION_IDENTIFIER,
  ACQUISITION_LINK_RETENTION_S,
  ACQUISITION_LINK_TTL_S,
  egressAbuseReviewGate,
  type AcquisitionRunKind,
} from "@/lib/abuse/egress-review-context";
import { createRedisClient } from "@/lib/rate-limit/redis";

// Diagnostic-only shadow of the egress review's acquisition links. Proxy
// telemetry identifies a workspace, never a run, so this index only lists the
// runs that could have used a workspace around a burst; it never names a cause.
// The review compares it with its own decision in an aggregate log line, and
// nothing here feeds a decision, case, receipt, cooldown or enforcement.
//
// Each run of a workspace keeps one record: the first and the latest verified
// acquisition. Reconnects move only that run's latest time, so they can never
// crowd out another run. Observed: verified acquisitions and reconnects at the
// shared cloud acquisition boundary. Not observed: tool calls on a cached
// client, lease heartbeats, run completion, and detached processes that keep
// running after their run ends.

/** Exactly "true" enables; unset, empty or "false" is off; anything else is invalid. */
export function runTimelineShadowGate(
  env: NodeJS.ProcessEnv = process.env,
): "on" | "off" | "invalid" {
  const value = env.E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED;
  if (!value || value === "false") return "off";
  return value === "true" ? "on" : "invalid";
}

const active = (env: NodeJS.ProcessEnv = process.env) =>
  egressAbuseReviewGate(env) === "on" && runTimelineShadowGate(env) === "on";

/** Runs kept per workspace; the least recently acquiring run is evicted first. */
export const MAX_TIMELINE_RUNS = 32;
/** Workspaces read for one burst; more are reported, not read. */
export const MAX_TIMELINE_WORKSPACES = 4;
const BUDGET_MS = 1_500;

/** Hashed so key names carry no account or provider identifiers. */
const timelineKeys = (
  region: E2BCluster,
  userId: string,
  sandboxId: string,
) => {
  const hash = createHash("sha256")
    .update(`${region}\n${userId}\n${sandboxId}`)
    .digest("hex")
    .slice(0, 32);
  // One hash tag keeps both keys of a script in one cluster slot.
  const base = `egress-review:timeline:v1:{${hash}}`;
  return [`${base}:runs`, `${base}:evicted`];
};
const runPrefix = (kind: AcquisitionRunKind, chatId: string, runId: string) =>
  `${kind === "parent" ? "p" : "s"}|${chatId}|${runId}|`;

/**
 * One atomic write per acquisition. Members are `<run prefix><first time>`,
 * scored by the run's latest acquisition. A run's first time only moves
 * earlier (an out-of-order write) and its latest time only moves later, so a
 * reconnect after a burst keeps the record that places the run before it.
 *
 * Records whose latest time is older than the retention are dropped: a review
 * can only verify a burst while its telemetry is kept, so no readable window
 * still includes them. Past the run bound, the least recently acquiring runs
 * are evicted and the evicted key keeps the newest latest time it removed, so
 * a reader can tell which windows may have lost a run. An evicted run that
 * acquires again starts a new record, losing the span that placed it in
 * between; the mark lives for twice the retention so a reader can still see
 * that possibility (see `readWorkspace`).
 */
const RECORD = `
local index, evicted, prefix = KEYS[1], KEYS[2], ARGV[1]
local now, cap, ttl = tonumber(ARGV[2]), tonumber(ARGV[4]), ARGV[5]
redis.call('ZREMRANGEBYSCORE', index, '-inf', '(' .. ARGV[3])
local entries = redis.call('ZRANGE', index, 0, -1, 'WITHSCORES')
local found, latest
for i = 1, #entries, 2 do
  if string.sub(entries[i], 1, #prefix) == prefix then
    found, latest = entries[i], tonumber(entries[i + 1])
  end
end
if not found then
  redis.call('ZADD', index, now, prefix .. ARGV[2])
else
  local first = tonumber(string.sub(found, #prefix + 1))
  if latest and now > latest then
    redis.call('ZADD', index, now, found)
    latest = now
  end
  if first and now < first then
    redis.call('ZREM', index, found)
    redis.call('ZADD', index, latest or now, prefix .. ARGV[2])
  end
end
local extra = redis.call('ZCARD', index) - cap
if extra > 0 then
  local removed = redis.call('ZRANGE', index, 0, extra - 1, 'WITHSCORES')
  redis.call('ZREMRANGEBYRANK', index, 0, extra - 1)
  local newest = tonumber(redis.call('GET', evicted) or '')
  for i = 2, #removed, 2 do
    local score = tonumber(removed[i])
    if score and (not newest or score > newest) then newest = score end
  end
  if newest then
    redis.call('SET', evicted, string.format('%.0f', newest), 'EX', tonumber(ttl) * 2)
  end
end
redis.call('EXPIRE', index, ttl)
return 1`;

/** Records whose latest time is at or after ARGV[1], and the eviction mark. */
const READ = `
local entries = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], '+inf', 'WITHSCORES', 'LIMIT', 0, ARGV[2])
return {entries, redis.call('GET', KEYS[2]) or ''}`;

type Redis = NonNullable<ReturnType<typeof createRedisClient>>;

function withinBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), BUDGET_MS);
    timer.unref?.();
  });
  return Promise.race([work, budget]).finally(() => clearTimeout(timer));
}

function logUnavailable(event: string) {
  try {
    console.warn(JSON.stringify({ event }));
  } catch {
    /* Diagnostics never affect acquisition or review. */
  }
}

/**
 * Best effort and never awaited: it cannot add latency to, fail or change an
 * acquisition. Called with the same verified inputs as the acquisition link,
 * and only while both the review and this shadow are switched on.
 */
export function recordRunTimelineAcquisition(input: {
  region: E2BCluster;
  userId: string;
  sandboxId: string;
  chatId?: string;
  runId?: string;
  runKind?: AcquisitionRunKind;
  now?: number;
}): void {
  try {
    if (!active()) return;
    const { region, userId, sandboxId, chatId, runId } = input;
    if (
      !chatId ||
      !runId ||
      ![userId, sandboxId, chatId, runId].every((value) =>
        ACQUISITION_IDENTIFIER.test(value),
      )
    )
      return;
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now)) return;
    const redis = createRedisClient();
    if (!redis) return;
    void withinBudget(
      redis.eval(RECORD, timelineKeys(region, userId, sandboxId), [
        runPrefix(input.runKind ?? "parent", chatId, runId),
        String(now),
        String(now - ACQUISITION_LINK_RETENTION_S * 1_000),
        String(MAX_TIMELINE_RUNS),
        String(ACQUISITION_LINK_RETENTION_S),
      ]),
    ).catch(() => logUnavailable("egress_run_timeline_record_unavailable"));
  } catch {
    logUnavailable("egress_run_timeline_record_unavailable");
  }
}

export type RunTimelineLimitation =
  /** A run whose latest acquisition fell inside this window was evicted. */
  | "evicted_in_window"
  /** A stored record or the eviction mark could not be read. */
  | "invalid_record"
  /** More records matched than the bound allows. */
  | "capped"
  /** More verified workspaces than are read for one burst. */
  | "workspaces_capped"
  /** At least one workspace could not be read within the budget. */
  | "workspace_unavailable";

/**
 * Closed counts only. A listed run is one that could have used a workspace
 * during the burst, never one shown to have caused it. With any limitation the
 * counts are lower bounds and the assessment is `incomplete`.
 */
export type RunTimelineSummary =
  | { status: "disabled" }
  | { status: "unavailable" }
  | {
      status: "read";
      assessment: "none" | "one_possible" | "several" | "incomplete";
      parents: number;
      subagents: number;
      /** Listed runs acquiring again after their first acquisition. */
      reconnected: number;
      /** Listed runs with an acquisition after the burst ended. */
      acquiredAfterBurst: number;
      workspaces: number;
      limitations: RunTimelineLimitation[];
    };

export type RunTimelineRead = {
  summary: RunTimelineSummary;
  /** Whether a run is listed; kept in memory and never logged. */
  lists(run: {
    kind: AcquisitionRunKind;
    chatId: string;
    runId: string;
  }): boolean;
};

type Candidate = {
  key: string;
  kind: AcquisitionRunKind;
  first: number;
  latest: number;
};

async function readWorkspace(
  redis: Redis,
  region: E2BCluster,
  userId: string,
  sandboxId: string,
  burst: { burstStart: number; burstEnd: number },
) {
  const windowStart = burst.burstStart - ACQUISITION_LINK_TTL_S * 1_000;
  const reply = await redis.eval<string[], unknown>(
    READ,
    timelineKeys(region, userId, sandboxId),
    [String(windowStart), String(MAX_TIMELINE_RUNS + 1)],
  );
  const limitations = new Set<RunTimelineLimitation>();
  const candidates: Candidate[] = [];
  const [entries, mark] = Array.isArray(reply) ? reply : [];
  if (!Array.isArray(entries) || entries.length % 2 || typeof mark !== "string")
    return { candidates, limitations: new Set(["invalid_record" as const]) };
  if (entries.length / 2 > MAX_TIMELINE_RUNS) limitations.add("capped");
  // The newest latest time of any evicted run. One in this window may have
  // been listed. One before it may have acquired again later as a new record
  // whose first time is after the burst, while it had been running across
  // the burst; retention would have kept the original record only if it
  // acquired again within the retention of its latest time.
  let evicted: number | undefined;
  if (mark) {
    evicted = Number(mark);
    if (!Number.isSafeInteger(evicted)) {
      limitations.add("invalid_record");
      evicted = undefined;
    } else if (evicted >= windowStart) limitations.add("evicted_in_window");
  }
  for (let index = 0; index < entries.length; index += 2) {
    const [kind, chatId, runId, firstText, extra] = String(
      entries[index],
    ).split("|");
    const first = Number(firstText);
    const latest = Number(entries[index + 1]);
    if (
      extra !== undefined ||
      (kind !== "p" && kind !== "s") ||
      !ACQUISITION_IDENTIFIER.test(chatId ?? "") ||
      !ACQUISITION_IDENTIFIER.test(runId ?? "") ||
      !Number.isSafeInteger(first) ||
      firstText !== String(first) ||
      !Number.isSafeInteger(latest) ||
      latest < first
    ) {
      limitations.add("invalid_record");
      continue;
    }
    if (
      evicted !== undefined &&
      first >= burst.burstEnd &&
      first <= evicted + ACQUISITION_LINK_RETENTION_S * 1_000
    )
      limitations.add("evicted_in_window");
    // Latest is in the window by the query; a run first acquiring after the
    // burst could not have used the workspace through this server during it.
    if (first < burst.burstEnd)
      candidates.push({
        key: `${kind}|${chatId}|${runId}`,
        kind: kind === "p" ? "parent" : "subagent",
        first,
        latest,
      });
  }
  return { candidates, limitations };
}

/**
 * Lists the runs that could have used each verified workspace of a burst:
 * first acquired before the burst ended, and acquired again no earlier than the
 * review's six-hour look-back before it began. Never rejects; failures become
 * `unavailable` or a limitation.
 */
export async function readRunTimeline(input: {
  region: E2BCluster;
  userId: string;
  sandboxIds: string[];
  burstStart: number;
  burstEnd: number;
}): Promise<RunTimelineRead> {
  const none: RunTimelineRead["lists"] = () => false;
  try {
    if (!active()) return { summary: { status: "disabled" }, lists: none };
    const redis = createRedisClient();
    if (!redis) return { summary: { status: "unavailable" }, lists: none };
    const read = input.sandboxIds.slice(0, MAX_TIMELINE_WORKSPACES);
    const results = await withinBudget(
      Promise.allSettled(
        read.map((sandboxId) =>
          readWorkspace(redis, input.region, input.userId, sandboxId, input),
        ),
      ),
    );
    const limitations = new Set<RunTimelineLimitation>();
    if (input.sandboxIds.length > read.length)
      limitations.add("workspaces_capped");
    const runs = new Map<string, Candidate>();
    let readable = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        limitations.add("workspace_unavailable");
        continue;
      }
      readable++;
      result.value.limitations.forEach((item) => limitations.add(item));
      // A run that used two workspaces is still one run.
      for (const candidate of result.value.candidates) {
        const known = runs.get(candidate.key);
        runs.set(candidate.key, {
          ...candidate,
          first: Math.min(candidate.first, known?.first ?? Infinity),
          latest: Math.max(candidate.latest, known?.latest ?? -Infinity),
        });
      }
    }
    if (!readable) return { summary: { status: "unavailable" }, lists: none };
    const listed = [...runs.values()];
    return {
      summary: {
        status: "read",
        assessment: limitations.size
          ? "incomplete"
          : listed.length === 0
            ? "none"
            : listed.length === 1
              ? "one_possible"
              : "several",
        parents: listed.filter((run) => run.kind === "parent").length,
        subagents: listed.filter((run) => run.kind === "subagent").length,
        reconnected: listed.filter((run) => run.latest > run.first).length,
        acquiredAfterBurst: listed.filter((run) => run.latest >= input.burstEnd)
          .length,
        workspaces: readable,
        limitations: [...limitations].sort(),
      },
      lists: (run) =>
        runs.has(
          `${run.kind === "parent" ? "p" : "s"}|${run.chatId}|${run.runId}`,
        ),
    };
  } catch {
    return { summary: { status: "unavailable" }, lists: none };
  }
}
