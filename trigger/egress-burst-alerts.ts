import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { idempotencyKeys, logger, schedules, tasks } from "@trigger.dev/sdk";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import { egressAbuseReviewGate } from "@/lib/abuse/egress-review-context";
import { reviewCaseKey, reviewWindowStart } from "@/lib/abuse/egress-review";
import {
  ATTRIBUTION_REF,
  resolveAttribution,
} from "@/lib/cloud-network/egress-attribution";
import {
  egressBurstThreshold,
  readTelemetryMinutes,
  TELEMETRY_REGIONS,
  TELEMETRY_RETENTION_S,
} from "@/lib/cloud-network/egress-telemetry";
import { createRedisClient } from "@/lib/rate-limit/redis";
import type { egressAbuseReviewTask } from "./egress-abuse-review";

// Operator monitor only: per-owner volumes of accepted attributed SOCKS
// connections, aggregated across that owner's workspaces in one region and
// minute. It never blocks, suspends or rate-limits anyone.
//
// High volume is not a monitoring failure. It is logged as a warning and sent
// to the operators' webhook, and the run succeeds. A run fails, reaching the
// environment's Trigger error alerts, only when the monitor itself is broken:
// configuration, state, heartbeat, collector loss, review dispatch or
// notification delivery.
//
// Notification is at least once. A candidate is marked notified only after the
// webhook accepts it, so a failed delivery or uncertain mark is retried by the
// next run while the minute is still in the evaluation window.

/** Collectors seal a minute after it ends; evaluate settled minutes only. */
const SETTLE_MINUTES = 2;
/** Re-read recent minutes so a briefly late upload is still evaluated. */
const EVALUATED_MINUTES = 5;
const NOTIFIED_TTL_S = 60 * 60;
/** New notified candidates per run; the rest are sent by the next runs. */
const MAX_NOTIFIED = 20;
const NOTIFICATION_TIMEOUT_MS = 5_000;
const NOTIFICATION_TITLE = "High connection volume";
/** New abuse reviews per run; the rest are dispatched by the next runs. */
const MAX_REVIEWS = 10;
const REVIEW_MARK_TTL_S = 2 * 60 * 60;
/** Lets most active runs persist their messages before review. */
const REVIEW_DELAY = "10m";
/** Reviews not yet dispatched, one per case, scored by burst minute. */
const REVIEW_QUEUE_KEY = "egress-abuse-review:v1:dispatch-queue";
/** Oldest entries read per run; at most MAX_REVIEWS of them are dispatched. */
const REVIEW_QUEUE_READ = 50;
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
  | { kind: "notification" }
  | { kind: "review" };

function describe(failure: Failure) {
  switch (failure.kind) {
    case "configuration":
      return "alert configuration is missing or invalid";
    case "review":
      return "abuse review could not be dispatched";
    case "notification":
      return `${NOTIFICATION_TITLE} notification could not be delivered`;
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

/** Fixed text only; never IDs, owner references or the webhook URL. */
export class EgressBurstAlertError extends Error {
  constructor(readonly failures: Failure[]) {
    const parts = [...new Set(failures.map(describe))].sort();
    super(`Egress attribution alert: ${parts.join("; ")}`);
    this.name = "EgressBurstAlertError";
  }
}

/**
 * The operators' private webhook, treated as a secret. HTTPS only, with no
 * embedded credentials or fragment.
 */
function notificationUrl(value: string | undefined) {
  if (!value || value.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url;
}

/**
 * Unset, empty or "false" is off. Enabled requires an explicit positive
 * per-owner threshold and notification URL: there is no default to activate
 * by accident.
 */
function resolveConfig() {
  const enabled = process.env.E2B_EGRESS_BURST_ALERTS_ENABLED;
  if (!enabled || enabled === "false") return null;
  const threshold = egressBurstThreshold();
  const url = notificationUrl(process.env.E2B_EGRESS_BURST_NOTIFICATION_URL);
  const review = egressAbuseReviewGate();
  const redis = createRedisClient();
  if (enabled !== "true" || threshold === null || !url || !redis)
    throw new EgressBurstAlertError([{ kind: "configuration" }]);
  if (review === "invalid")
    logger.warn("Invalid egress abuse review configuration");
  return { threshold, url, redis, review: review === "on" };
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

// v2: v1 marked candidates logged, not notified.
const notifiedKey = ({ region, minute, owner }: Candidate) =>
  `egress-burst:v2:${region}:${minute}:${owner}`;

export type EgressBurstAlertResult = { status: "disabled" | "ok" };

export async function runEgressBurstAlerts(
  scheduledAt: Date,
): Promise<EgressBurstAlertResult> {
  const config = resolveConfig();
  if (!config) return { status: "disabled" };
  const { threshold, url, redis, review } = config;
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
    if (records.every((record) => record === null))
      failures.push({ kind: "heartbeat", region });
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
      for (const entry of owners.values())
        if (entry.connections >= threshold) candidates.push(entry);
    });
  }

  candidates.sort((a, b) => b.connections - a.connections);
  await notifyNewCandidates(redis, url, candidates, threshold, failures);
  if (review) await dispatchReviews(redis, candidates, failures, latest);

  if (failures.length) throw new EgressBurstAlertError(failures);
  return { status: "ok" };
}

/**
 * For candidates not yet notified, at most MAX_NOTIFIED per run: writes the
 * detailed warning, sends one webhook message for all of them, and marks each
 * notified only after the webhook accepts it. A failed read, warning or mark
 * is a state failure and a failed delivery a notification failure; either
 * leaves the candidate for the next run, which may warn or send it again.
 */
async function notifyNewCandidates(
  redis: NonNullable<ReturnType<typeof createRedisClient>>,
  url: URL,
  candidates: Candidate[],
  threshold: number,
  failures: Failure[],
) {
  if (!candidates.length) return;
  let notified: unknown[];
  try {
    notified = await redis.mget<unknown[]>(...candidates.map(notifiedKey));
  } catch {
    failures.push({ kind: "state" });
    return;
  }
  const pending = candidates.filter((_, index) => notified[index] === null);
  const warned: Candidate[] = [];
  for (const candidate of pending.slice(0, MAX_NOTIFIED)) {
    const { region, minute, owner, connections } = candidate;
    try {
      if (owner === "overflow")
        logger.warn(NOTIFICATION_TITLE, {
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
        logger.warn(NOTIFICATION_TITLE, {
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
      warned.push(candidate);
    } catch {
      failures.push({ kind: "state" });
    }
  }
  if (pending.length > MAX_NOTIFIED)
    logger.warn(
      `${NOTIFICATION_TITLE} notifications deferred to the next run`,
      {
        pending: pending.length,
        notified: MAX_NOTIFIED,
      },
    );
  if (!warned.length) return;

  if (!(await deliverNotification(url, warned, threshold))) {
    failures.push({ kind: "notification" });
    return;
  }
  for (const candidate of warned)
    try {
      await redis.set(notifiedKey(candidate), "1", { ex: NOTIFIED_TTL_S });
    } catch {
      failures.push({ kind: "state" });
    }
}

/** One line per candidate, with opaque owner references only. */
function notificationText(candidates: Candidate[], threshold: number) {
  const lines = candidates.map(({ region, minute, owner, connections }) => {
    // 2026-11-21T08:15Z
    const utc = `${new Date(minute * 60_000).toISOString().slice(0, 16)}Z`;
    const who = owner === "overflow" ? "unattributed" : `owner ${owner}`;
    return `${region} ${utc} ${who}: ${connections} connections (threshold ${threshold})`;
  });
  return [NOTIFICATION_TITLE, ...lines].join("\n");
}

/**
 * Slack-compatible incoming webhook message. Accepted only on a 2xx response
 * without redirects. The response body and any fetch error are discarded:
 * they can echo the secret URL.
 */
async function deliverNotification(
  url: URL,
  candidates: Candidate[],
  threshold: number,
) {
  try {
    // The path can contain a delivery credential. Keep it out of HTTP spans.
    const response = await context.with(suppressTracing(context.active()), () =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: notificationText(candidates, threshold) }),
        redirect: "error",
        signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
      }),
    );
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

const reviewMarkKey = (caseKey: string) => `${caseKey}:dispatched`;

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
) {
  const oldest = latest - REVIEW_QUEUE_RETENTION_MINUTES;
  try {
    // Retire the entire expired range even when the queue is larger than one page.
    const expired = await redis.zremrangebyscore(
      REVIEW_QUEUE_KEY,
      "-inf",
      oldest - 1,
    );
    if (expired > 0) {
      failures.push({ kind: "review" });
      logger.warn("Egress abuse reviews expired before dispatch", { expired });
    }
  } catch {
    failures.push({ kind: "review" });
    return;
  }
  const byCase = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (candidate.owner === "overflow" || !candidate.complete) continue;
    const key = reviewCaseKey(
      candidate.region,
      candidate.owner,
      reviewWindowStart(candidate.minute),
    );
    // Candidates are largest first; keep each window's largest minute.
    if (!byCase.has(key)) byCase.set(key, candidate);
  }
  if (byCase.size) {
    try {
      const keys = [...byCase.keys()];
      const marks = await redis.mget<unknown[]>(...keys.map(reviewMarkKey));
      const fresh = keys.filter((_, index) => marks[index] === null);
      if (fresh.length) {
        // NX keeps the minute an entry was first queued with.
        const [first, ...rest] = fresh.map((key) => ({
          score: byCase.get(key)!.minute,
          member: key,
        }));
        await redis.zadd(REVIEW_QUEUE_KEY, { nx: true }, first, ...rest);
        await redis.expire(REVIEW_QUEUE_KEY, TELEMETRY_RETENTION_S);
      }
    } catch {
      // The candidates stay in the evaluation window for the next run.
      failures.push({ kind: "review" });
    }
  }

  let raw: unknown[];
  try {
    raw = await redis.zrange<unknown[]>(
      REVIEW_QUEUE_KEY,
      0,
      REVIEW_QUEUE_READ - 1,
      { withScores: true },
    );
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
  try {
    marks = await redis.mget<unknown[]>(
      ...due.map(({ key }) => reviewMarkKey(key)),
    );
  } catch {
    failures.push({ kind: "review" });
    return;
  }
  const done = due.filter((_, index) => marks[index] !== null);
  const pending = due.filter((_, index) => marks[index] === null);
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
