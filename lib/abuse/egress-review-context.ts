import { createHash } from "node:crypto";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
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

/** Long enough for an Agent run that acquired before a burst plus review retries. */
export const ACQUISITION_LINK_TTL_S = 6 * 60 * 60;
/**
 * Distinct runs kept per workspace. One more is retained so a reader can tell
 * that older links were trimmed and treat the set as incomplete.
 */
export const MAX_ACQUISITION_LINKS = 16;
const RECORD_BUDGET_MS = 1_500;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;

export type AcquisitionRunKind = "parent" | "subagent";
export type AcquisitionLink = {
  kind: AcquisitionRunKind;
  chatId: string;
  runId: string;
  /** Latest successful acquisition of this workspace by this run. */
  acquiredAt: number;
};

type Redis = NonNullable<ReturnType<typeof createRedisClient>>;

/** Hashed so Redis key names carry no account or provider identifiers. */
const linkKey = (region: E2BCluster, userId: string, sandboxId: string) =>
  `egress-review:v1:${region}:acquisition:${createHash("sha256")
    .update(`${userId}\n${sandboxId}`)
    .digest("hex")
    .slice(0, 32)}`;

// One member per run: a repeat acquisition by the same run refreshes its score,
// and concurrent runs never overwrite each other.
const encodeMember = (
  kind: AcquisitionRunKind,
  chatId: string,
  runId: string,
) => `${kind === "parent" ? "p" : "s"}|${chatId}|${runId}`;

function decodeMember(value: unknown, score: unknown): AcquisitionLink | null {
  if (typeof value !== "string") return null;
  const [kind, chatId, runId, extra] = value.split("|");
  const acquiredAt = Number(score);
  if (
    extra !== undefined ||
    (kind !== "p" && kind !== "s") ||
    !IDENTIFIER.test(chatId ?? "") ||
    !IDENTIFIER.test(runId ?? "") ||
    !Number.isSafeInteger(acquiredAt)
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
    const key = linkKey(region, userId, sandboxId);
    const write = redis
      .pipeline()
      .zadd(key, {
        score: now,
        member: encodeMember(input.runKind ?? "parent", chatId, runId),
      })
      .zremrangebyscore(key, 0, now - ACQUISITION_LINK_TTL_S * 1_000)
      .zremrangebyrank(key, 0, -(MAX_ACQUISITION_LINKS + 2))
      .expire(key, ACQUISITION_LINK_TTL_S)
      .exec();
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
 * Links recorded for one verified workspace since `since`. `complete` is false
 * when older runs were trimmed or a stored member is unreadable, so the caller
 * cannot mistake a partial set for the only plausible run.
 */
export async function readAcquisitionLinks(
  redis: Redis,
  region: E2BCluster,
  userId: string,
  sandboxId: string,
  since: number,
): Promise<{ links: AcquisitionLink[]; complete: boolean }> {
  const raw = await redis.zrange<unknown[]>(
    linkKey(region, userId, sandboxId),
    0,
    -1,
    { withScores: true },
  );
  const links: AcquisitionLink[] = [];
  let complete = raw.length / 2 <= MAX_ACQUISITION_LINKS;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const link = decodeMember(raw[index], raw[index + 1]);
    if (!link) complete = false;
    else if (link.acquiredAt >= since) links.push(link);
  }
  return { links, complete: complete && raw.length % 2 === 0 };
}
