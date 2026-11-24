import { createHash } from "node:crypto";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import { TELEMETRY_RETENTION_S } from "@/lib/cloud-network/egress-telemetry";
import { createRedisClient } from "@/lib/rate-limit/redis";

// Short-lived links from a verified cloud workspace to the server-side chat and
// Trigger run that acquired it. The egress abuse review reads them to find the
// exact run active during a burst; a link alone never attributes a connection.

/** Exactly "true" enables; unset, empty or "false" is off; anything else is invalid. */
export function egressAbuseReviewGate(
  env: NodeJS.ProcessEnv = process.env,
): "on" | "off" | "invalid" {
  const value = env.E2B_EGRESS_ABUSE_REVIEW_ENABLED;
  if (!value || value === "false") return "off";
  return value === "true" ? "on" : "invalid";
}

/** How far before a burst a review looks for the runs that acquired its workspace. */
export const ACQUISITION_LINK_TTL_S = 6 * 60 * 60;
/**
 * Records are kept longer than the review looks back. A review starts after
 * its burst and can still verify it only while the burst's telemetry is kept,
 * so a write between the burst and its review must not trim a record that the
 * review's look-back window still includes. The extra 30 minutes covers late
 * collector uploads.
 */
export const ACQUISITION_LINK_RETENTION_S =
  ACQUISITION_LINK_TTL_S + TELEMETRY_RETENTION_S + 30 * 60;
/**
 * Acquisition records kept per workspace, across all runs. One more is
 * retained so a reader can tell that older records were trimmed and treat the
 * set as incomplete. Repeated acquisitions by one run are coalesced on write,
 * so this bounds distinct runs and long-lived runs rather than reconnects.
 */
export const MAX_ACQUISITION_LINKS = 16;
const RECORD_BUDGET_MS = 1_500;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;

export type AcquisitionRunKind = "parent" | "subagent";
/** One successful acquisition of a workspace by a run. */
export type AcquisitionLink = {
  kind: AcquisitionRunKind;
  chatId: string;
  runId: string;
  acquiredAt: number;
};

type Redis = NonNullable<ReturnType<typeof createRedisClient>>;

// v2 keeps one member per acquisition. v1 kept one member per run scored by
// its latest acquisition, so a re-acquisition after a burst replaced the
// record that placed the run before it. v1 keys are never read: a reader
// cannot tell whether such a record was overwritten. They expire on their own.
/** Hashed so Redis key names carry no account or provider identifiers. */
const linkKey = (region: E2BCluster, userId: string, sandboxId: string) =>
  `egress-review:v2:${region}:acquisition:${createHash("sha256")
    .update(`${userId}\n${sandboxId}`)
    .digest("hex")
    .slice(0, 32)}`;

// The time is part of the member: a later acquisition by the same run adds a
// record instead of moving the earlier one, a retried write of the same
// acquisition is idempotent, and concurrent runs never overwrite each other.
// Members are `<run prefix><time>`; the prefix identifies kind, chat and run.
const runPrefix = (kind: AcquisitionRunKind, chatId: string, runId: string) =>
  `${kind === "parent" ? "p" : "s"}|${chatId}|${runId}|`;

/**
 * One atomic write per acquisition. A review asks whether a run has any
 * record in [burst start - look-back, burst end), a window at least as long
 * as the look-back. A reconnecting run would otherwise add a record per
 * reconnect and crowd other runs out of the bounded set.
 *
 * So when the run's two newest valid records are P <= L and the new time T
 * satisfies T - P <= look-back, L is replaced by T. Any such window that
 * contained L still contains P (it ends by T, so it starts by T - look-back
 * <= P) or T (it ends after T). The newest record is always kept and P is
 * never removed, so each removal leaves a witness for every window it
 * covered, and the run keeps at most a few records per look-back.
 *
 * Only members whose time equals their score are considered; anything else
 * stays and keeps the set incomplete for the reader. Retention trimming runs
 * first, and the rank trim still keeps one record past the bound so the
 * reader can see that older records were dropped.
 */
const RECORD_ACQUISITION = `
local key, prefix, now = KEYS[1], ARGV[1], tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[3])
local member = prefix .. ARGV[2]
if not redis.call('ZSCORE', key, member) then
  local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
  local latest, latestAt, previousAt
  for i = 1, #entries, 2 do
    if entries[i] == prefix .. entries[i + 1] then
      previousAt, latest, latestAt = latestAt, entries[i], tonumber(entries[i + 1])
    end
  end
  if previousAt and latestAt < now and now - previousAt <= tonumber(ARGV[4]) then
    redis.call('ZREM', key, latest)
  end
  redis.call('ZADD', key, now, member)
end
redis.call('ZREMRANGEBYRANK', key, 0, -tonumber(ARGV[5]))
redis.call('EXPIRE', key, ARGV[6])
return 1`;

function decodeMember(value: unknown, score: unknown): AcquisitionLink | null {
  if (typeof value !== "string") return null;
  const [kind, chatId, runId, time, extra] = value.split("|");
  const acquiredAt = Number(score);
  if (
    extra !== undefined ||
    (kind !== "p" && kind !== "s") ||
    !IDENTIFIER.test(chatId ?? "") ||
    !IDENTIFIER.test(runId ?? "") ||
    !Number.isSafeInteger(acquiredAt) ||
    time !== String(acquiredAt)
  )
    return null;
  return {
    kind: kind === "p" ? "parent" : "subagent",
    chatId,
    runId,
    acquiredAt,
  };
}

function logRecordUnavailable() {
  try {
    console.warn(
      JSON.stringify({ event: "egress_review_acquisition_link_unavailable" }),
    );
  } catch {
    /* Diagnostics never affect acquisition. */
  }
}

/**
 * Best effort and never awaited by the caller: it cannot add latency to,
 * fail, or change an acquisition. Called only after the provider confirmed
 * ownership and the network was verified. Acquisitions without a server chat
 * and run are not recorded; the review then has no link and abstains.
 */
export function recordEgressReviewAcquisition(input: {
  region: E2BCluster;
  userId: string;
  sandboxId: string;
  chatId?: string;
  runId?: string;
  runKind?: AcquisitionRunKind;
  now?: number;
}): void {
  try {
    if (egressAbuseReviewGate() !== "on") return;
    const { region, userId, sandboxId, chatId, runId } = input;
    if (
      !chatId ||
      !runId ||
      !IDENTIFIER.test(userId) ||
      !IDENTIFIER.test(sandboxId) ||
      !IDENTIFIER.test(chatId) ||
      !IDENTIFIER.test(runId)
    )
      return;
    const redis = createRedisClient();
    if (!redis) return;
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now)) return;
    const key = linkKey(region, userId, sandboxId);
    const write = redis.eval(
      RECORD_ACQUISITION,
      [key],
      [
        runPrefix(input.runKind ?? "parent", chatId, runId),
        String(now),
        String(now - ACQUISITION_LINK_RETENTION_S * 1_000),
        String(ACQUISITION_LINK_TTL_S * 1_000),
        String(MAX_ACQUISITION_LINKS + 2),
        String(ACQUISITION_LINK_RETENTION_S),
      ],
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("timed out")),
        RECORD_BUDGET_MS,
      );
      timer.unref?.();
    });
    void Promise.race([write, budget])
      .catch(logRecordUnavailable)
      .finally(() => clearTimeout(timer));
  } catch {
    logRecordUnavailable();
  }
}

/**
 * Acquisitions recorded for one verified workspace since `since`, oldest
 * first; a run that acquired more than once may have several records.
 * `complete` is false when older records were trimmed or a stored member is
 * unreadable, so the caller cannot mistake a partial set for the only
 * plausible run; `incomplete` says which, and `stored` counts the raw
 * records, for closed diagnostics only.
 */
export async function readAcquisitionLinks(
  redis: Redis,
  region: E2BCluster,
  userId: string,
  sandboxId: string,
  since: number,
): Promise<{
  links: AcquisitionLink[];
  complete: boolean;
  incomplete?: "invalid" | "trimmed";
  stored: number;
}> {
  const raw = await redis.zrange<unknown[]>(
    linkKey(region, userId, sandboxId),
    0,
    -1,
    { withScores: true },
  );
  const links: AcquisitionLink[] = [];
  let invalid = raw.length % 2 !== 0;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const link = decodeMember(raw[index], raw[index + 1]);
    if (!link) invalid = true;
    else if (link.acquiredAt >= since) links.push(link);
  }
  const stored = Math.floor(raw.length / 2);
  const incomplete = invalid
    ? ("invalid" as const)
    : stored > MAX_ACQUISITION_LINKS
      ? ("trimmed" as const)
      : undefined;
  return {
    links,
    complete: !incomplete,
    ...(incomplete ? { incomplete } : {}),
    stored,
  };
}
