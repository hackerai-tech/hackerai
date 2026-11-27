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
 * Acquisition records kept per workspace, across all runs. Repeated
 * acquisitions by one run are coalesced on write, so this bounds distinct runs
 * and long-lived runs rather than reconnects. The review separately abstains
 * when more than 16 distinct runs fall inside its window.
 */
export const MAX_ACQUISITION_RECORDS = 48;
/**
 * The previous writer kept 16 records plus one more as a trim sentinel and
 * wrote no metadata, so an unmarked set above this size may have lost records
 * anywhere and is never read as complete.
 */
const LEGACY_RECORD_LIMIT = 16;
/** Members at most a writer leaves: the records plus one metadata member. */
const MAX_STORED_MEMBERS = MAX_ACQUISITION_RECORDS + 1;
/**
 * The one metadata member, `m|<bound>` at score 0, below every positive
 * acquisition time and retention cutoff. Every record a writer dropped other
 * than by retention or coalescing has a time at or before the bound; 0 means
 * none. The previous writer's time prune removes it before its rank trim.
 */
const MARK_PREFIX = "m|";
const RECORD_BUDGET_MS = 1_500;
/** Chat, run, account and workspace identifiers safe to store in a member. */
export const ACQUISITION_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;

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
 * Only members whose time equals a safe integer score are considered; anything
 * else stays and keeps the set incomplete for the reader.
 *
 * The metadata member is read and set aside first, then retention trimming
 * runs. Past the record bound the oldest records are evicted, and the bound
 * becomes the newest evicted time: a rank trim removes only records ranked
 * below every survivor, ties included, so none of them is newer. A set
 * without metadata above the previous writer's size may be one it trimmed:
 * its oldest record before this write bounds what that writer evicted, since
 * a later out-of-order record can rank below it. Unreadable or duplicate
 * metadata says nothing, so the bound becomes the newest time present or now.
 * A bound at or before the retention cutoff can no longer reach a review
 * window, which already relies on retention-trimmed records being out of
 * range. Metadata is written while the set is above the previous writer's
 * size, so a reader can tell it from a set that writer trimmed, or while the
 * bound is still in range.
 */
const RECORD_ACQUISITION = `
local key, prefix, now = KEYS[1], ARGV[1], tonumber(ARGV[2])
local cutoff, keep, legacy = tonumber(ARGV[3]), tonumber(ARGV[5]), tonumber(ARGV[6])
local maxSafe = 9007199254740991
local entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
local marks, bound, newest = 0, nil, now
for i = 1, #entries, 2 do
  local score = tonumber(entries[i + 1]) or maxSafe
  if score > newest then newest = score end
  if string.sub(entries[i], 1, 2) == 'm|' then
    marks = marks + 1
    local text = string.sub(entries[i], 3)
    if entries[i + 1] == '0' and text:match('^%d+$') and (text == '0' or text:sub(1, 1) ~= '0')
      and tonumber(text) <= maxSafe then
      bound = tonumber(text)
    end
    redis.call('ZREM', key, entries[i])
  end
end
if marks > 1 or (marks == 1 and not bound) then bound = newest end
redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[3])
if marks == 0 and redis.call('ZCARD', key) > legacy then
  bound = tonumber(redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2]) or maxSafe
end
local member = prefix .. ARGV[2]
if not redis.call('ZSCORE', key, member) then
  entries = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')
  local latest, latestAt, previousAt
  for i = 1, #entries, 2 do
    local scoreText = entries[i + 1]
    local score = tonumber(scoreText)
    if score and scoreText:match('^-?%d+$') and math.abs(score) <= maxSafe
      and entries[i] == prefix .. scoreText then
      previousAt, latest, latestAt = latestAt, entries[i], score
    end
  end
  if previousAt and latestAt < now and now - previousAt <= tonumber(ARGV[4]) then
    redis.call('ZREM', key, latest)
  end
  redis.call('ZADD', key, now, member)
end
local extra = redis.call('ZCARD', key) - keep
if extra > 0 then
  local removed = redis.call('ZRANGE', key, 0, extra - 1, 'WITHSCORES')
  redis.call('ZREMRANGEBYRANK', key, 0, extra - 1)
  for i = 2, #removed, 2 do
    local score = tonumber(removed[i]) or maxSafe
    if not bound or score > bound then bound = score end
  end
end
if bound and bound <= cutoff then bound = nil end
if bound or redis.call('ZCARD', key) > legacy then
  bound = math.min(math.ceil(bound or 0), maxSafe)
  redis.call('ZADD', key, 0, 'm|' .. string.format('%.0f', bound))
end
redis.call('EXPIRE', key, ARGV[7])
return 1`;

function decodeMember(value: unknown, score: unknown): AcquisitionLink | null {
  if (typeof value !== "string") return null;
  const [kind, chatId, runId, time, extra] = value.split("|");
  const acquiredAt = Number(score);
  if (
    extra !== undefined ||
    (kind !== "p" && kind !== "s") ||
    !ACQUISITION_IDENTIFIER.test(chatId ?? "") ||
    !ACQUISITION_IDENTIFIER.test(runId ?? "") ||
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
      !ACQUISITION_IDENTIFIER.test(userId) ||
      !ACQUISITION_IDENTIFIER.test(sandboxId) ||
      !ACQUISITION_IDENTIFIER.test(chatId) ||
      !ACQUISITION_IDENTIFIER.test(runId)
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
        String(MAX_ACQUISITION_RECORDS),
        String(LEGACY_RECORD_LIMIT),
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

/** The metadata bound, or null when the member is not valid metadata. */
function decodeMark(value: string, score: unknown): number | null {
  const text = value.slice(MARK_PREFIX.length);
  const bound = Number(text);
  return (score === 0 || score === "0") &&
    /^(?:0|[1-9]\d*)$/.test(text) &&
    Number.isSafeInteger(bound)
    ? bound
    : null;
}

/**
 * Acquisitions recorded for one verified workspace since `since`, oldest
 * first; a run that acquired more than once may have several records.
 * `complete` is false when a record at or after `since` may have been
 * trimmed, or a stored member is unreadable, so the caller cannot mistake a
 * partial set for the only plausible run; `incomplete` says which, and
 * `stored` counts the raw records, for closed diagnostics only.
 *
 * Trimmed history is complete only for a window starting strictly after the
 * writer's metadata bound. A set without metadata is complete only within the
 * previous writer's size, and more members than a writer leaves are
 * unreadable.
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
  // One past the most a writer leaves, so an overfull set is visible.
  const raw = await redis.zrange<unknown[]>(
    linkKey(region, userId, sandboxId),
    0,
    MAX_STORED_MEMBERS,
    { withScores: true },
  );
  const links: AcquisitionLink[] = [];
  let invalid = raw.length % 2 !== 0 || raw.length / 2 > MAX_STORED_MEMBERS;
  let marks = 0;
  let bound: number | null = null;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const [member, score] = [raw[index], raw[index + 1]];
    if (typeof member === "string" && member.startsWith(MARK_PREFIX)) {
      marks++;
      bound = decodeMark(member, score);
      continue;
    }
    const link = decodeMember(member, score);
    if (!link) invalid = true;
    else if (link.acquiredAt >= since) links.push(link);
  }
  if (marks > 1 || (marks === 1 && bound === null)) invalid = true;
  const stored = Math.floor(raw.length / 2) - marks;
  const incomplete = invalid
    ? ("invalid" as const)
    : (bound === null ? stored > LEGACY_RECORD_LIMIT : bound >= since)
      ? ("trimmed" as const)
      : undefined;
  return {
    links,
    complete: !incomplete,
    ...(incomplete ? { incomplete } : {}),
    stored,
  };
}
