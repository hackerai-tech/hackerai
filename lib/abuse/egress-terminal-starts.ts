import { createHash } from "node:crypto";
import type { E2BCluster } from "@/lib/ai/tools/utils/e2b-cluster";
import {
  ACQUISITION_IDENTIFIER,
  egressAbuseReviewGate,
  type AcquisitionRunKind,
} from "@/lib/abuse/egress-review-context";
import { TELEMETRY_RETENTION_S } from "@/lib/cloud-network/egress-telemetry";
import { createRedisClient } from "@/lib/rate-limit/redis";

// Diagnostic-only record of which runs began a foreground terminal command on
// a verified cloud workspace in a given minute. It answers whether verified
// command starts happened near a burst; it never shows that a command opened
// a connection, never names a cause, and nothing here feeds a decision, case,
// receipt, cooldown, attribution or enforcement.
//
// Observed: non-interactive foreground `run_terminal_cmd` commands that the
// E2B SDK accepted with a process ID, on a client object that this process
// verified for ownership and network. Not observed: detached/background and
// interactive commands, other tools and SDK paths, local and Desktop
// sandboxes, processes started before recording or on another worker, and
// lost writes. Counts are lower bounds; zero never means no activity.

/** Exactly "true" enables; unset, empty or "false" is off; anything else is invalid. */
export function terminalStartShadowGate(
  env: NodeJS.ProcessEnv = process.env,
): "on" | "off" | "invalid" {
  const value = env.E2B_EGRESS_TERMINAL_START_SHADOW_ENABLED;
  if (!value || value === "false") return "off";
  return value === "true" ? "on" : "invalid";
}

const active = (env: NodeJS.ProcessEnv = process.env) =>
  egressAbuseReviewGate(env) === "on" && terminalStartShadowGate(env) === "on";

/** Distinct runs kept per workspace and minute; more set the capped marker. */
export const MAX_STARTING_RUNS_PER_MINUTE = 8;
/** Workspaces read for one burst; more are reported, not read. */
export const MAX_START_WORKSPACES = 4;
/**
 * Minutes read on each side of the burst minute. Matches the review's
 * one-minute clock skew between the proxy and the worker, and lets a command
 * started late in the preceding minute be seen.
 */
export const START_MARGIN_MINUTES = 1;
/** Kept as long as the burst telemetry a review can still verify, plus late uploads. */
const RETENTION_S = TELEMETRY_RETENTION_S + 30 * 60;
const BUDGET_MS = 1_500;
/** Bounds the identities bound to one client object. */
const MAX_BOUND_RUNS = 8;
const CAPPED = "!";
const MEMBER = /^[ps][0-9a-f]{24}$/;

/** Hashed so key names carry no account or provider identifiers. */
const startKeys = (region: E2BCluster, userId: string, sandboxId: string) => {
  const hash = createHash("sha256")
    .update(`${region}\n${userId}\n${sandboxId}`)
    .digest("hex")
    .slice(0, 32);
  // One hash tag keeps every key of a workspace in one cluster slot.
  const base = `egress-review:starts:v1:{${hash}}`;
  return {
    since: `${base}:since`,
    minute: (minute: number) => `${base}:m:${minute}`,
  };
};

/** Pseudonymous run key: kind plus a truncated hash of the chat and run. */
const runMember = (kind: AcquisitionRunKind, chatId: string, runId: string) =>
  `${kind === "parent" ? "p" : "s"}${createHash("sha256")
    .update(`${chatId}\n${runId}`)
    .digest("hex")
    .slice(0, 24)}`;

/**
 * One atomic write. KEYS[1] holds the earliest time recording was seen active
 * for the workspace, refreshed on every write so it lapses only after a gap of
 * the retention. With a member, KEYS[2] is the minute's set of runs: a known
 * member is a no-op, a new one is added below the cap, and past the cap only
 * the capped marker is added. Retries and out-of-order writes are idempotent.
 */
const RECORD = `
local now, ttl, member, cap = tonumber(ARGV[1]), tonumber(ARGV[2]), ARGV[3], tonumber(ARGV[4])
local since = tonumber(redis.call('GET', KEYS[1]) or '')
if not since or now < since then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
else
  redis.call('EXPIRE', KEYS[1], ttl)
end
if member ~= '' then
  if redis.call('SISMEMBER', KEYS[2], member) == 0 then
    local runs = redis.call('SCARD', KEYS[2]) - redis.call('SISMEMBER', KEYS[2], '${CAPPED}')
    if runs < cap then
      redis.call('SADD', KEYS[2], member)
    else
      redis.call('SADD', KEYS[2], '${CAPPED}')
    end
  end
  redis.call('EXPIRE', KEYS[2], ttl)
end
return 1`;

/** The recording-since time, then each minute's bounded set of members. */
const READ = `
local out = {redis.call('GET', KEYS[1]) or ''}
local maxMembers = ${MAX_STARTING_RUNS_PER_MINUTE + 1}
for i = 2, #KEYS do
  local key = KEYS[i]
  if redis.call('SCARD', key) > maxMembers then
    out[i] = false
  else
    out[i] = redis.call('SMEMBERS', key)
  end
end
return out`;

type Redis = NonNullable<ReturnType<typeof createRedisClient>>;

function withinBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), BUDGET_MS);
    timer.unref?.();
  });
  return Promise.race([work, budget]).finally(() => clearTimeout(timer));
}

function logUnavailable() {
  try {
    console.warn(
      JSON.stringify({ event: "egress_terminal_start_record_unavailable" }),
    );
  } catch {
    /* Diagnostics never affect a command. */
  }
}

type Workspace = { region: E2BCluster; userId: string; sandboxId: string };
type Binding = Workspace & {
  /** `<chatId>\n<runId>` to the run's kind and the last minute written. */
  runs: Map<string, { kind: AcquisitionRunKind; minute?: number }>;
};

/**
 * Keyed by the exact E2B client object a verified acquisition returned, so a
 * command is only attributed to the workspace, owner and region that this
 * process checked for that object, never to a preferred or default route.
 */
const bindings = new WeakMap<object, Binding>();

function write(redis: Redis, keys: string[], args: string[]) {
  return withinBudget(redis.eval(RECORD, keys, args));
}

/**
 * Called once ownership and network checks for `sandbox` succeeded, with the
 * same verified inputs as the acquisition link. Synchronous, never throws.
 */
export function bindVerifiedTerminalWorkspace(
  sandbox: object,
  verified: Workspace & {
    chatId?: string;
    runId?: string;
    runKind?: AcquisitionRunKind;
    now?: number;
  },
): void {
  try {
    if (!active()) return;
    const { region, userId, sandboxId, chatId, runId } = verified;
    if (
      !chatId ||
      !runId ||
      ![userId, sandboxId, chatId, runId].every((value) =>
        ACQUISITION_IDENTIFIER.test(value),
      )
    )
      return;
    let binding = bindings.get(sandbox);
    if (
      !binding ||
      binding.region !== region ||
      binding.userId !== userId ||
      binding.sandboxId !== sandboxId
    ) {
      binding = { region, userId, sandboxId, runs: new Map() };
      bindings.set(sandbox, binding);
    }
    const run = `${chatId}\n${runId}`;
    const kind = verified.runKind ?? "parent";
    if (binding.runs.get(run)?.kind !== kind) {
      binding.runs.delete(run);
      if (binding.runs.size >= MAX_BOUND_RUNS)
        binding.runs.delete(binding.runs.keys().next().value!);
      binding.runs.set(run, { kind });
    }
    const now = verified.now ?? Date.now();
    const redis = Number.isSafeInteger(now) ? createRedisClient() : null;
    if (!redis) return;
    write(
      redis,
      [startKeys(region, userId, sandboxId).since],
      [String(now), String(RETENTION_S), "", "0"],
    ).catch(logUnavailable);
  } catch {
    logUnavailable();
  }
}

/**
 * Records that the SDK accepted a foreground command with process ID `pid`.
 * Call after the start resolves and before waiting for it. Skips unbound or
 * non-E2B objects, an invalid PID, and any server identity that does not
 * match what was verified for this object. A bound client normally writes
 * once per run and minute. The stored set also deduplicates across clients.
 */
export function recordVerifiedTerminalStart(
  sandbox: unknown,
  start: {
    pid: unknown;
    userId: string;
    chatId: string;
    runId?: string;
    now?: number;
  },
): void {
  try {
    if (!active() || !sandbox || typeof sandbox !== "object") return;
    const binding = bindings.get(sandbox);
    const { pid, userId, chatId, runId } = start;
    if (
      !binding ||
      !runId ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      binding.userId !== userId ||
      (sandbox as { sandboxId?: unknown }).sandboxId !== binding.sandboxId
    )
      return;
    const run = binding.runs.get(`${chatId}\n${runId}`);
    const now = start.now ?? Date.now();
    if (!run || !Number.isSafeInteger(now)) return;
    const minute = Math.floor(now / 60_000);
    if (run.minute === minute) return;
    const redis = createRedisClient();
    if (!redis) return;
    run.minute = minute;
    const keys = startKeys(binding.region, binding.userId, binding.sandboxId);
    write(
      redis,
      [keys.since, keys.minute(minute)],
      [
        String(now),
        String(RETENTION_S),
        runMember(run.kind, chatId, runId),
        String(MAX_STARTING_RUNS_PER_MINUTE),
      ],
    ).catch(() => {
      // A later command in the same minute may retry the write.
      if (run.minute === minute) run.minute = undefined;
      logUnavailable();
    });
  } catch {
    logUnavailable();
  }
}

export type TerminalStartLimitation =
  /** A minute reached the per-minute run bound. */
  | "capped"
  /** A stored member or time could not be read. */
  | "invalid_record"
  /** More verified workspaces than are read for one burst. */
  | "workspaces_capped"
  /** At least one workspace could not be read within the budget. */
  | "workspace_unavailable"
  /** Recording was not seen active for a workspace before the read window. */
  | "workspace_unobserved";

/**
 * Closed counts only. A counted run is one that began a verified foreground
 * command near the burst, never one shown to have opened its connections.
 * - `unobserved`: nothing recorded and recording was not seen active before
 *   the window, so the absence says nothing.
 * - `no_observed_starts`: recording had been seen, and no start was recorded.
 *   Commands already running, other paths and lost writes remain possible.
 * - `partial`: a limitation applies; counts are lower bounds.
 */
export type TerminalStartSummary =
  | { status: "disabled" }
  | { status: "unavailable" }
  | {
      status: "read";
      assessment:
        | "unobserved"
        | "no_observed_starts"
        | "one_run"
        | "several_runs"
        | "partial";
      /** Runs with a recorded start in the burst minute. */
      burstMinuteRuns: number;
      /** Runs recorded only in the adjacent margin minutes. */
      marginOnlyRuns: number;
      parents: number;
      subagents: number;
      workspaces: number;
      limitations: TerminalStartLimitation[];
    };

export type TerminalStartRead = {
  summary: TerminalStartSummary;
  /** Whether a run has a recorded start in the read window; in memory only. */
  started(run: {
    kind: AcquisitionRunKind;
    chatId: string;
    runId: string;
  }): boolean;
};

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && String(timestamp) === value
    ? timestamp
    : undefined;
}

async function readWorkspace(
  redis: Redis,
  workspace: Workspace,
  minutes: number[],
  windowStart: number,
) {
  const keys = startKeys(
    workspace.region,
    workspace.userId,
    workspace.sandboxId,
  );
  const reply = await redis.eval<string[], unknown>(
    READ,
    [keys.since, ...minutes.map(keys.minute)],
    [],
  );
  const limitations = new Set<TerminalStartLimitation>();
  const byMinute: string[][] = [];
  if (!Array.isArray(reply) || reply.length !== minutes.length + 1)
    return { byMinute, limitations: new Set(["invalid_record" as const]) };
  const [since, ...sets] = reply;
  const observedSince = parseTimestamp(since);
  if (observedSince === undefined && since !== "")
    limitations.add("invalid_record");
  if (observedSince === undefined || observedSince > windowStart)
    limitations.add("workspace_unobserved");
  for (const members of sets) {
    const runs: string[] = [];
    if (!Array.isArray(members)) {
      limitations.add("invalid_record");
    } else {
      for (const member of members) {
        if (member === CAPPED) limitations.add("capped");
        else if (typeof member === "string" && MEMBER.test(member))
          runs.push(member);
        else limitations.add("invalid_record");
      }
      if (runs.length > MAX_STARTING_RUNS_PER_MINUTE)
        limitations.add("invalid_record");
    }
    byMinute.push(runs);
  }
  return { byMinute, limitations };
}

/**
 * Reads the burst minute and its margins for each verified workspace (at most
 * four). Never rejects; failures become `unavailable` or a limitation.
 */
export async function readTerminalStarts(input: {
  region: E2BCluster;
  userId: string;
  sandboxIds: string[];
  burstStart: number;
  burstEnd: number;
}): Promise<TerminalStartRead> {
  const none: TerminalStartRead["started"] = () => false;
  try {
    if (!active()) return { summary: { status: "disabled" }, started: none };
    const burstMinute = input.burstStart / 60_000;
    if (
      !Number.isSafeInteger(burstMinute) ||
      burstMinute < START_MARGIN_MINUTES ||
      !Number.isSafeInteger(input.burstEnd) ||
      input.burstEnd !== input.burstStart + 60_000
    )
      return { summary: { status: "unavailable" }, started: none };
    const redis = createRedisClient();
    if (!redis) return { summary: { status: "unavailable" }, started: none };
    const minutes = [
      burstMinute - START_MARGIN_MINUTES,
      burstMinute,
      burstMinute + START_MARGIN_MINUTES,
    ];
    const windowStart = minutes[0] * 60_000;
    const read = input.sandboxIds.slice(0, MAX_START_WORKSPACES);
    const results = await withinBudget(
      Promise.allSettled(
        read.map((sandboxId) =>
          readWorkspace(
            redis,
            { region: input.region, userId: input.userId, sandboxId },
            minutes,
            windowStart,
          ),
        ),
      ),
    );
    const limitations = new Set<TerminalStartLimitation>();
    if (input.sandboxIds.length > read.length)
      limitations.add("workspaces_capped");
    const inBurst = new Set<string>();
    const all = new Set<string>();
    let readable = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        limitations.add("workspace_unavailable");
        continue;
      }
      readable++;
      result.value.limitations.forEach((item) => limitations.add(item));
      result.value.byMinute.forEach((runs, index) => {
        const minute = minutes[index];
        for (const run of runs) {
          all.add(run);
          if (minute === burstMinute) inBurst.add(run);
        }
      });
    }
    if (!readable) return { summary: { status: "unavailable" }, started: none };
    const onlyUnobserved =
      limitations.size === 1 && limitations.has("workspace_unobserved");
    const assessment =
      onlyUnobserved && all.size === 0
        ? "unobserved"
        : limitations.size
          ? "partial"
          : all.size === 0
            ? "no_observed_starts"
            : all.size === 1
              ? "one_run"
              : "several_runs";
    const runs = [...all];
    return {
      summary: {
        status: "read",
        assessment,
        burstMinuteRuns: inBurst.size,
        marginOnlyRuns: all.size - inBurst.size,
        parents: runs.filter((run) => run[0] === "p").length,
        subagents: runs.filter((run) => run[0] === "s").length,
        workspaces: readable,
        limitations: [...limitations].sort(),
      },
      started: (run) => all.has(runMember(run.kind, run.chatId, run.runId)),
    };
  } catch {
    return { summary: { status: "unavailable" }, started: none };
  }
}
