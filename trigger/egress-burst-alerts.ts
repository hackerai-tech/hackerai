import { idempotencyKeys, logger, schedules, tasks } from "@trigger.dev/sdk";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import { egressAbuseReviewGate } from "@/lib/abuse/egress-review-context";
import { reviewCaseKey, reviewWindowStart } from "@/lib/abuse/egress-review";
import {
  cooldownSuppresses,
  readReviewCooldowns,
} from "@/lib/abuse/egress-review-cooldown";
import {
  ATTRIBUTION_REF,
  resolveAttribution,
  resolveOwners,
} from "@/lib/cloud-network/egress-attribution";
import {
  egressBurstThreshold,
  readTelemetryMinutes,
  TELEMETRY_REGIONS,
  TELEMETRY_RETENTION_S,
  type TelemetryMinute,
} from "@/lib/cloud-network/egress-telemetry";
import { createRedisClient } from "@/lib/rate-limit/redis";
import type { egressAbuseReviewTask } from "./egress-abuse-review";

// Operator monitor only: per-owner volumes of accepted attributed SOCKS
// connections, aggregated across that owner's workspaces in one region and
// minute. It never blocks, suspends or rate-limits anyone.
//
// High volume is logged as a warning in Trigger and the run succeeds. Failures
// in configuration, telemetry, warning state or review dispatch fail the run.

/** Collectors seal a minute after it ends; evaluate settled minutes only. */
const SETTLE_MINUTES = 2;
/** Re-read recent minutes so a briefly late upload is still evaluated. */
const EVALUATED_MINUTES = 5;
const WARNING_TTL_S = 60 * 60;
/** New warnings per run; later runs handle the rest. */
const MAX_WARNINGS = 20;
const WARNING_TITLE = "High connection volume";
/** New abuse reviews per run; the rest are dispatched by the next runs. */
const MAX_REVIEWS = 10;
const REVIEW_MARK_TTL_S = 2 * 60 * 60;
/** Lets most active runs persist their messages before review. */
const REVIEW_DELAY = "10m";
/** Reviews not yet dispatched, one per case, scored by burst minute. */
const REVIEW_QUEUE_KEY = "egress-abuse-review:v1:dispatch-queue";
/** Oldest entries read per run; at most MAX_REVIEWS of them are dispatched. */
const REVIEW_QUEUE_READ = 250;
const REVIEW_QUEUE_CAPACITY = 2_000;
/**
 * The review rereads its minute's telemetry, kept for TELEMETRY_RETENTION_S
 * (two hours). It starts REVIEW_DELAY after dispatch and its retries can add
 * about 45 minutes more, so a queued minute older than this is reported and
 * removed rather than dispatched to a review that could no longer verify it.
 */
const REVIEW_QUEUE_RETENTION_MINUTES = 30;

type Failure =
  | { kind: "configuration" }
  | { kind: "state"; region?: E2BCluster }
  | { kind: "heartbeat"; region: E2BCluster }
  | { kind: "loss"; region: E2BCluster }
  | { kind: "review" };

function describe(failure: Failure) {
  switch (failure.kind) {
    case "configuration":
      return "alert configuration is missing or invalid";
    case "review":
      return "abuse review could not be dispatched";
    case "state":
      return failure.region
        ? `${failure.region} telemetry could not be read`
        : "alert state could not be recorded";
    case "heartbeat":
      return `${failure.region} collector heartbeat missing`;
    case "loss":
      return `${failure.region} collector reported lost telemetry`;
  }
}

/** Fixed text only; excludes IDs and owner references. */
export class EgressBurstAlertError extends Error {
  constructor(readonly failures: Failure[]) {
    const parts = [...new Set(failures.map(describe))].sort();
    super(`Egress attribution alert: ${parts.join("; ")}`);
    this.name = "EgressBurstAlertError";
  }
}

/** Unset, empty or "false" is off. Enabled requires a positive threshold. */
function resolveConfig() {
  const enabled = process.env.E2B_EGRESS_BURST_ALERTS_ENABLED;
  if (!enabled || enabled === "false") return null;
  const threshold = egressBurstThreshold();
  const review = egressAbuseReviewGate();
  const redis = createRedisClient();
  if (enabled !== "true" || threshold === null || !redis)
    throw new EgressBurstAlertError([{ kind: "configuration" }]);
  if (review === "invalid")
    logger.warn("Invalid egress abuse review configuration");
  return { threshold, redis, review: review === "on" };
}

type Candidate = {
  region: E2BCluster;
  minute: number;
  /** An owner reference, or "overflow" for unnamed identities. */
  owner: string;
  connections: number;
  workspaces: string[];
  /** The minute reported no loss, so its counts are verified complete. */
  complete: boolean;
};

function ownerBursts(
  region: E2BCluster,
  minute: number,
  record: TelemetryMinute,
  threshold: number,
  complete: boolean,
) {
  const owners = new Map<string, Candidate>();
  for (const [owner, workspace, connections] of record.counts) {
    const entry = owners.get(owner) ?? {
      region,
      minute,
      owner,
      connections: 0,
      workspaces: [],
      complete,
    };
    entry.connections += connections;
    entry.workspaces.push(workspace);
    owners.set(owner, entry);
  }
  return [...owners.values()].filter((entry) => entry.connections >= threshold);
}

const warningKey = ({ region, minute, owner }: Candidate) =>
  `egress-burst:warning:v1:${region}:${minute}:${owner}`;

export type EgressBurstAlertResult = { status: "disabled" | "ok" };

export async function runEgressBurstAlerts(
  scheduledAt: Date,
): Promise<EgressBurstAlertResult> {
  const config = resolveConfig();
  if (!config) return { status: "disabled" };
  const { threshold, redis, review } = config;
  const latest =
    Math.floor(new Date(scheduledAt).getTime() / 60_000) - SETTLE_MINUTES;
  if (!Number.isSafeInteger(latest))
    throw new EgressBurstAlertError([{ kind: "configuration" }]);
  const minutes = Array.from(
    { length: EVALUATED_MINUTES },
    (_, index) => latest - index,
  );

  const failures: Failure[] = [];
  const candidates: Candidate[] = [];
  for (const region of TELEMETRY_REGIONS) {
    let records;
    try {
      records = await readTelemetryMinutes(redis, region, minutes);
    } catch {
      failures.push({ kind: "state", region });
      continue;
    }
    // Every collector uploads each minute, even with no connections.
    if (records.every((record) => record === null)) {
      failures.push({ kind: "heartbeat", region });
      // The exact settled window, to compare with the collector's journal
      // and the route's receipts; the error text stays fixed for grouping.
      const first = minutes[minutes.length - 1];
      try {
        logger.warn("Egress collector heartbeat missing", {
          region,
          firstMinute: first,
          lastMinute: latest,
          windowStart: new Date(first * 60_000).toISOString(),
          windowEnd: new Date((latest + 1) * 60_000).toISOString(),
          scheduledAt: new Date(scheduledAt).toISOString(),
        });
      } catch {
        // The recorded heartbeat failure still reports the gap.
      }
    }
    records.forEach((record, index) => {
      if (!record) return;
      const minute = minutes[index];
      const complete =
        record.complete && !record.droppedEvents && !record.droppedBatches;
      // A broken journal stream cannot quantify its missing events. Treat
      // incomplete minutes as loss too, including the initial partial minute.
      if (!complete) failures.push({ kind: "loss", region });
      if (!complete)
        logger.warn("Egress telemetry incomplete", {
          region,
          minute,
          complete: record.complete,
          droppedEvents: record.droppedEvents,
          droppedBatches: record.droppedBatches,
        });
      // Identities past the collector's cardinality bound are counted, not
      // named; a large overflow could hide a burst.
      if (record.overflowConnections >= threshold)
        candidates.push({
          region,
          minute,
          owner: "overflow",
          connections: record.overflowConnections,
          workspaces: [],
          complete,
        });
      candidates.push(
        ...ownerBursts(region, minute, record, threshold, complete),
      );
    });
  }

  candidates.sort((a, b) => b.connections - a.connections);
  await warnForNewCandidates(redis, candidates, threshold, failures);
  if (review) {
    // Retained telemetry recovers work that could not be written to the queue.
    const replayMinutes = Array.from(
      { length: REVIEW_QUEUE_RETENTION_MINUTES - EVALUATED_MINUTES + 1 },
      (_, index) => latest - EVALUATED_MINUTES - index,
    );
    const reviews = [...candidates];
    for (const region of TELEMETRY_REGIONS) {
      try {
        const records = await readTelemetryMinutes(
          redis,
          region,
          replayMinutes,
        );
        records.forEach((record, index) => {
          if (
            record?.complete &&
            !record.droppedEvents &&
            !record.droppedBatches
          )
            reviews.push(
              ...ownerBursts(
                region,
                replayMinutes[index],
                record,
                threshold,
                true,
              ),
            );
        });
      } catch {
        failures.push({ kind: "review" });
      }
    }
    await dispatchReviews(redis, reviews, failures, latest, threshold);
  }

  if (failures.length) throw new EgressBurstAlertError(failures);
  return { status: "ok" };
}

/**
 * Marks each candidate after its warning is logged. A failed warning or mark
 * leaves it eligible for another attempt while its minute is still in the window.
 */
async function warnForNewCandidates(
  redis: NonNullable<ReturnType<typeof createRedisClient>>,
  candidates: Candidate[],
  threshold: number,
  failures: Failure[],
) {
  if (!candidates.length) return;
  let marks: unknown[];
  try {
    marks = await redis.mget<unknown[]>(...candidates.map(warningKey));
  } catch {
    failures.push({ kind: "state" });
    return;
  }
  const pending = candidates.filter((_, index) => marks[index] === null);
  for (const candidate of pending.slice(0, MAX_WARNINGS)) {
    const { region, minute, owner, connections } = candidate;
    try {
      if (owner === "overflow")
        logger.warn(WARNING_TITLE, {
          region,
          minute,
          unattributed: true,
          connections,
          threshold,
        });
      else {
        const resolved = await resolveAttribution(
          redis,
          region,
          owner,
          candidate.workspaces,
        );
        logger.warn(WARNING_TITLE, {
          region,
          minute,
          ownerRef: owner,
          userId: resolved.userId ?? null,
          sandboxIds: resolved.sandboxIds,
          unverifiedWorkspaces: resolved.unverifiedWorkspaces,
          workspaces: candidate.workspaces.length,
          connections,
          threshold,
        });
      }
      await redis.set(warningKey(candidate), "1", { ex: WARNING_TTL_S });
    } catch {
      failures.push({ kind: "state" });
    }
  }
  if (pending.length > MAX_WARNINGS)
    logger.warn(`${WARNING_TITLE} warnings deferred to the next run`, {
      pending: pending.length,
      warned: MAX_WARNINGS,
    });
}

const reviewMarkKey = (caseKey: string) => `${caseKey}:dispatched`;
const reviewRetryKey = (caseKey: string) => `${caseKey}:retry-after`;

type QueuedReview = {
  key: string;
  region: E2BCluster;
  owner: string;
  minute: number;
};

/** The member is the case key, which is also the review's idempotency key. */
function decodeQueuedReview(
  member: unknown,
  score: unknown,
): QueuedReview | null {
  if (typeof member !== "string") return null;
  const minute = Number(score);
  const [, , region, owner] = member.split(":");
  if (
    !Number.isSafeInteger(minute) ||
    !TELEMETRY_REGIONS.includes(region as E2BCluster) ||
    !ATTRIBUTION_REF.test(owner ?? "") ||
    member !==
      reviewCaseKey(region as E2BCluster, owner, reviewWindowStart(minute))
  )
    return null;
  return { key: member, region: region as E2BCluster, owner, minute };
}

/**
 * Hands verified, complete owner bursts to the read-only abuse review, one per
 * owner, region and 30-minute UTC window. The payload carries opaque
 * references only.
 *
 * Each candidate not yet dispatched is first added to a Redis queue, scored
 * by its minute, so a review deferred by the per-run cap or a failed dispatch
 * survives its minute leaving the evaluation window. Every run then drains
 * the oldest entries, with or without new candidates. A global idempotency
 * key per case dedupes overlapping runs, sustained bursts and a dispatch
 * whose outcome was uncertain; the Redis mark only avoids asking Trigger
 * again. An entry leaves the queue after its dispatch is marked. Any store or
 * dispatch failure fails the run, and an entry too old for the review to
 * recheck its telemetry is removed only as a reported failure.
 */
async function dispatchReviews(
  redis: NonNullable<ReturnType<typeof createRedisClient>>,
  candidates: Candidate[],
  failures: Failure[],
  latest: number,
  threshold: number,
) {
  const oldest = latest - REVIEW_QUEUE_RETENTION_MINUTES;
  try {
    const outdated = await redis.zrange<string[]>(
      REVIEW_QUEUE_KEY,
      "-inf",
      oldest - 1,
      {
        byScore: true,
        offset: 0,
        count: REVIEW_QUEUE_READ,
      },
    );
    if (outdated.length) {
      const marks = await redis.mget<unknown[]>(...outdated.map(reviewMarkKey));
      await redis.zrem(REVIEW_QUEUE_KEY, ...outdated);
      const expired = marks.filter((mark) => mark === null).length;
      if (expired > 0) {
        failures.push({ kind: "review" });
        logger.warn("Egress abuse reviews expired before dispatch", {
          expired,
        });
      }
    }
  } catch {
    failures.push({ kind: "review" });
    return;
  }
  const byCase = new Map<string, Candidate>();
  /** Highest owner volume seen in each case window, for the cooldown. */
  const peaks = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.owner === "overflow") continue;
    const key = reviewCaseKey(
      candidate.region,
      candidate.owner,
      reviewWindowStart(candidate.minute),
    );
    peaks.set(key, Math.max(peaks.get(key) ?? 0, candidate.connections));
    if (!candidate.complete) continue;
    // Current candidates come first, followed by replay candidates.
    if (!byCase.has(key)) byCase.set(key, candidate);
  }
  if (byCase.size) {
    try {
      const keys = [...byCase.keys()];
      const marks = await redis.mget<unknown[]>(...keys.map(reviewMarkKey));
      const fresh = keys.filter((_, index) => marks[index] === null);
      if (fresh.length) {
        const [existing, count] = await Promise.all([
          redis.zmscore(REVIEW_QUEUE_KEY, fresh),
          redis.zcard(REVIEW_QUEUE_KEY),
        ]);
        if (existing?.length !== fresh.length)
          throw new Error("Incomplete queue lookup");
        const missing = await withoutCooldown(
          redis,
          fresh.filter((_, index) => existing[index] === null),
          byCase,
          peaks,
          threshold,
        );
        const remaining = Math.max(0, REVIEW_QUEUE_CAPACITY - count);
        if (missing.length > remaining) failures.push({ kind: "review" });
        const [first, ...rest] = missing.slice(0, remaining).map((key) => ({
          score: byCase.get(key)!.minute,
          member: key,
        }));
        if (first) {
          // NX keeps the minute an entry was first queued with.
          await redis.zadd(REVIEW_QUEUE_KEY, { nx: true }, first, ...rest);
          await redis.expire(REVIEW_QUEUE_KEY, TELEMETRY_RETENTION_S);
        }
      }
    } catch {
      // The candidates stay in the evaluation window for the next run.
      failures.push({ kind: "review" });
    }
  }

  let raw: unknown[];
  try {
    raw = await redis.zrange<unknown[]>(REVIEW_QUEUE_KEY, oldest, latest, {
      byScore: true,
      offset: 0,
      count: REVIEW_QUEUE_READ,
      withScores: true,
    });
  } catch {
    failures.push({ kind: "review" });
    return;
  }
  const due: QueuedReview[] = [];
  const invalid: string[] = [];
  if (raw.length % 2 !== 0) failures.push({ kind: "review" });
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const entry = decodeQueuedReview(raw[index], raw[index + 1]);
    if (entry && entry.minute >= oldest) due.push(entry);
    else {
      failures.push({ kind: "review" });
      const member = raw[index];
      if (typeof member === "string") invalid.push(member);
    }
  }
  if (invalid.length) {
    try {
      await redis.zrem(REVIEW_QUEUE_KEY, ...invalid);
    } catch {
      // Already reported; the next run removes them.
    }
  }
  if (!due.length) return;

  let marks: unknown[];
  let retries: (number | null)[];
  try {
    [marks, retries] = await Promise.all([
      redis.mget<unknown[]>(...due.map(({ key }) => reviewMarkKey(key))),
      redis.mget<(number | null)[]>(
        ...due.map(({ key }) => reviewRetryKey(key)),
      ),
    ]);
  } catch {
    failures.push({ kind: "review" });
    return;
  }
  const done = due.filter((_, index) => marks[index] !== null);
  // Preserve chronological order within each group and give untried work priority.
  const pending = due
    .map((entry, index) => ({
      entry,
      mark: marks[index],
      retry: retries[index],
    }))
    .filter(({ mark, retry }) => mark === null && (retry ?? 0) <= latest)
    .sort((a, b) => Number(a.retry !== null) - Number(b.retry !== null))
    .map(({ entry }) => entry);
  for (const { key, region, owner, minute } of pending.slice(0, MAX_REVIEWS)) {
    try {
      await tasks.trigger<typeof egressAbuseReviewTask>(
        "egress-abuse-review",
        { region, owner, minute },
        {
          idempotencyKey: await idempotencyKeys.create(key, {
            scope: "global",
          }),
          idempotencyKeyTTL: "1d",
          delay: REVIEW_DELAY,
        },
      );
      await redis.set(reviewMarkKey(key), "1", { ex: REVIEW_MARK_TTL_S });
      done.push({ key, region, owner, minute });
    } catch {
      failures.push({ kind: "review" });
      try {
        await redis.set(reviewRetryKey(key), latest + 1, {
          ex: REVIEW_QUEUE_RETENTION_MINUTES * 60,
        });
      } catch {
        // The failure is already surfaced. Keep the entry for the next pass.
      }
    }
  }
  if (done.length)
    try {
      await redis.zrem(REVIEW_QUEUE_KEY, ...done.map(({ key }) => key));
    } catch {
      // Marked entries are removed by the next run.
      failures.push({ kind: "review" });
    }
  if (pending.length > MAX_REVIEWS || raw.length / 2 >= REVIEW_QUEUE_READ)
    logger.warn("Egress abuse reviews deferred to the next run", {
      pending: pending.length,
      dispatched: Math.min(pending.length, MAX_REVIEWS),
    });
}

/**
 * Leaves out new cases whose verified account has an active review cooldown
 * and whose window is a routine spike. It reads only when there are new cases
 * to queue: one attribution read and one cooldown read for all of them. A
 * left-out case is not marked, so a later, materially higher minute of the
 * same window is checked again and queued. Any read failure queues every case;
 * the review repeats the check against the whole window before evidence or a
 * model call.
 */
async function withoutCooldown(
  redis: NonNullable<ReturnType<typeof createRedisClient>>,
  keys: string[],
  byCase: Map<string, Candidate>,
  peaks: Map<string, number>,
  threshold: number,
) {
  if (!keys.length) return keys;
  try {
    const userIds = await resolveOwners(
      redis,
      keys.map((key) => byCase.get(key)!),
    );
    const verified = userIds.flatMap((userId) => (userId ? [userId] : []));
    const cooldowns = new Map(
      (await readReviewCooldowns(redis, verified)).map(
        (cooldown, index) => [verified[index], cooldown] as const,
      ),
    );
    const kept = keys.filter((key, index) => {
      const userId = userIds[index];
      return !(
        userId &&
        cooldownSuppresses(
          cooldowns.get(userId) ?? null,
          peaks.get(key) ?? byCase.get(key)!.connections,
          threshold,
        )
      );
    });
    if (kept.length < keys.length)
      logger.info("Egress abuse reviews suppressed by cooldown", {
        suppressed: keys.length - kept.length,
      });
    return kept;
  } catch {
    logger.warn("Egress abuse review cooldown check unavailable");
    return keys;
  }
}

export const egressBurstAlertsTask = schedules.task({
  id: "egress-burst-alerts",
  // Production only, every minute.
  cron: { pattern: "* * * * *", environments: ["PRODUCTION"] },
  machine: { preset: "small-1x" },
  maxDuration: 60,
  // No retry: the next minute's run re-evaluates the same window.
  retry: { maxAttempts: 1 },
  queue: { name: "egress-burst-alerts", concurrencyLimit: 1 },
  run: (payload) => runEgressBurstAlerts(payload.timestamp),
});
