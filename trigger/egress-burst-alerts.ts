import { idempotencyKeys, logger, schedules, tasks } from "@trigger.dev/sdk";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import { egressAbuseReviewGate } from "@/lib/abuse/egress-review-context";
import { reviewCaseKey, reviewWindowStart } from "@/lib/abuse/egress-review";
import { resolveAttribution } from "@/lib/cloud-network/egress-attribution";
import {
  egressBurstThreshold,
  readTelemetryMinutes,
  TELEMETRY_REGIONS,
} from "@/lib/cloud-network/egress-telemetry";
import { createRedisClient } from "@/lib/rate-limit/redis";
import type { egressAbuseReviewTask } from "./egress-abuse-review";

// Operator alert only: per-owner bursts of accepted attributed SOCKS
// connections, aggregated across that owner's workspaces in one region and
// minute. It never blocks, suspends or rate-limits anyone. A failed run
// reaches the environment's existing Trigger error alerts.
//
// Delivery is at least once: every run fails while a burst is inside the
// evaluation window, so a crashed or lost run is repeated by the next one.
// Only the detailed operator log is deduplicated, and it is marked done after
// it is written, so an uncertain write may log a burst twice.

/** Collectors seal a minute after it ends; evaluate settled minutes only. */
const SETTLE_MINUTES = 2;
/** Re-read recent minutes so a briefly late upload is still evaluated. */
const EVALUATED_MINUTES = 5;
const LOGGED_TTL_S = 60 * 60;
/** New detailed logs per run; the rest are logged by the next runs. */
const MAX_LOGGED = 20;
const MAX_MESSAGE_PARTS = 20;
/** New abuse reviews per run; the rest are dispatched by the next runs. */
const MAX_REVIEWS = 10;
const REVIEW_MARK_TTL_S = 2 * 60 * 60;
/** Lets most active runs persist their messages before review. */
const REVIEW_DELAY = "10m";

type Failure =
  | { kind: "configuration" }
  | { kind: "state"; region?: E2BCluster }
  | { kind: "heartbeat"; region: E2BCluster }
  | { kind: "loss"; region: E2BCluster }
  | { kind: "burst"; region: E2BCluster; owner: string }
  | { kind: "overflow"; region: E2BCluster }
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
    case "overflow":
      return `${failure.region} unattributed overflow at or over threshold`;
    case "burst":
      return `${failure.region} connection burst for owner ${failure.owner}`;
  }
}

/** Fixed text plus opaque owner references; never user or sandbox IDs. */
export class EgressBurstAlertError extends Error {
  constructor(readonly failures: Failure[]) {
    const parts = [...new Set(failures.map(describe))].sort();
    const shown = parts.slice(0, MAX_MESSAGE_PARTS);
    super(
      `Egress attribution alert: ${shown.join("; ")}${
        parts.length > shown.length
          ? `; and ${parts.length - shown.length} more`
          : ""
      }`,
    );
    this.name = "EgressBurstAlertError";
  }
}

/**
 * Unset, empty or "false" is off. Enabled requires an explicit positive
 * per-owner threshold: there is no default to activate by accident.
 */
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

const loggedKey = ({ region, minute, owner }: Candidate) =>
  `egress-burst:v1:${region}:${minute}:${owner}`;

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

  // Every candidate fails this run, whether or not it was logged before.
  for (const { region, owner } of candidates)
    failures.push(
      owner === "overflow"
        ? { kind: "overflow", region }
        : { kind: "burst", region, owner },
    );
  candidates.sort((a, b) => b.connections - a.connections);
  await logNewCandidates(redis, candidates, threshold, failures);
  if (review) await dispatchReviews(redis, candidates, failures);

  if (failures.length) throw new EgressBurstAlertError(failures);
  return { status: "ok" };
}

/**
 * Writes the detailed log for candidates not yet logged, at most MAX_LOGGED
 * per run, then marks each done. A failed read, log or mark is a state
 * failure that leaves the candidate for the next run.
 */
async function logNewCandidates(
  redis: NonNullable<ReturnType<typeof createRedisClient>>,
  candidates: Candidate[],
  threshold: number,
  failures: Failure[],
) {
  if (!candidates.length) return;
  let logged: unknown[];
  try {
    logged = await redis.mget<unknown[]>(...candidates.map(loggedKey));
  } catch {
    failures.push({ kind: "state" });
    return;
  }
  const pending = candidates.filter((_, index) => logged[index] === null);
  for (const candidate of pending.slice(0, MAX_LOGGED)) {
    const { region, minute, owner, connections } = candidate;
    try {
      if (owner === "overflow")
        logger.error("Egress unattributed overflow over threshold", {
          region,
          minute,
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
        logger.error("Egress connection burst", {
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
      await redis.set(loggedKey(candidate), "1", { ex: LOGGED_TTL_S });
    } catch {
      failures.push({ kind: "state" });
    }
  }
  if (pending.length > MAX_LOGGED)
    logger.warn("Egress burst logs deferred to the next run", {
      pending: pending.length,
      logged: MAX_LOGGED,
    });
}

const reviewMarkKey = (caseKey: string) => `${caseKey}:dispatched`;

/**
 * Hands verified, complete owner bursts to the read-only abuse review, one per
 * owner, region and 30-minute UTC window. A global idempotency key dedupes
 * overlapping runs and sustained bursts; the Redis mark only avoids asking
 * Trigger again every minute. The payload carries opaque references only.
 * A failed dispatch is not marked and is retried by the next run.
 */
async function dispatchReviews(
  redis: NonNullable<ReturnType<typeof createRedisClient>>,
  candidates: Candidate[],
  failures: Failure[],
) {
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
  if (!byCase.size) return;
  const keys = [...byCase.keys()];
  let marks: unknown[];
  try {
    marks = await redis.mget<unknown[]>(...keys.map(reviewMarkKey));
  } catch {
    failures.push({ kind: "review" });
    return;
  }
  const pending = keys.filter((_, index) => marks[index] === null);
  for (const key of pending.slice(0, MAX_REVIEWS)) {
    const { region, owner, minute } = byCase.get(key)!;
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
    } catch {
      failures.push({ kind: "review" });
    }
  }
  if (pending.length > MAX_REVIEWS)
    logger.warn("Egress abuse reviews deferred to the next run", {
      pending: pending.length,
      dispatched: MAX_REVIEWS,
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
