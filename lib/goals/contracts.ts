export const GOAL_FLAG = "persistent-agent-goals";
const GOAL_MAX_EVIDENCE = 64;
export const GOAL_SLICE_MS = 20 * 60 * 1000;
export const GOAL_STATES = [
  "queued",
  "running",
  "waiting",
  "paused",
  "needs_input",
  "needs_approval",
  "blocked",
  "failed",
  "canceled",
  "usage_exhausted",
  "budget_exhausted",
  "achieved",
] as const;
export type GoalState = (typeof GOAL_STATES)[number];
export type GoalEvidence = {
  criterion: number;
  runId: string;
  messageId?: string;
  toolCallId: string;
  explanation: string;
};
/** Keep earlier stages of a criterion; a new tool result does not replace its history. */
export function mergeGoalEvidence<
  T extends Pick<GoalEvidence, "criterion" | "runId" | "toolCallId">,
>(prior: T[], current: T[]): T[] {
  const distinct = new Map<string, T>();
  for (const proof of [...prior, ...current]) {
    const key = JSON.stringify([
      proof.criterion,
      proof.runId,
      proof.toolCallId,
    ]);
    distinct.delete(key);
    distinct.set(key, proof);
  }
  const all = [...distinct.values()];
  if (all.length <= GOAL_MAX_EVIDENCE) return all;
  // Preserve coverage for every criterion (at most eight), then recent history.
  const keep = new Set<T>();
  const covered = new Set<number>();
  for (let i = all.length - 1; i >= 0; i--) {
    if (!covered.has(all[i].criterion)) {
      covered.add(all[i].criterion);
      keep.add(all[i]);
    }
  }
  for (let i = all.length - 1; i >= 0 && keep.size < GOAL_MAX_EVIDENCE; i--) {
    keep.add(all[i]);
  }
  return all.filter((proof) => keep.has(proof));
}

export type GoalCheckpoint = {
  outcome: "continue" | "achieved" | "needs_input" | "blocked" | "wait";
  progress: string;
  evidence: GoalEvidence[];
  waitSeconds?: number;
};
export type GoalContract = {
  verificationCommand?: string;
  constraints?: string;
  boundaries?: string;
  stopWhen?: string;
};
export type GoalJudgment = {
  verdict: "done" | "continue" | "blocked";
  reason: string;
};

// Long objectives retain their full text; the default criterion references it
// instead of duplicating it into a field with a smaller limit.
export function defaultGoalCriterion(objective: string): string {
  return objective.trim().length <= 1000
    ? objective.trim()
    : "The full stated objective has been achieved and verified.";
}

export function validGoalStart(
  value: unknown,
): value is { objective: string; criteria: string[] } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.objective === "string" &&
    v.objective.trim().length > 0 &&
    v.objective.length <= 4000 &&
    Array.isArray(v.criteria) &&
    v.criteria.length > 0 &&
    v.criteria.length <= 8 &&
    v.criteria.every(
      (c) => typeof c === "string" && c.trim().length > 0 && c.length <= 1000,
    ) &&
    ["verificationCommand", "constraints", "boundaries", "stopWhen"].every(
      (key) =>
        v[key] === undefined ||
        (typeof v[key] === "string" && (v[key] as string).length <= 2000),
    )
  );
}

/** An executed tool is provenance, not proof that the model's interpretation is true. */
export function isGoalEvidencePart(part: unknown, toolCallId: string): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  if (
    p.toolCallId !== toolCallId ||
    typeof p.type !== "string" ||
    !p.type.startsWith("tool-") ||
    [
      "tool-goal_checkpoint",
      "tool-todo_write",
      "tool-list_agents",
      "tool-send_message_to_agent",
      "tool-delegate_task",
      "tool-continue_agent",
    ].includes(p.type) ||
    p.state !== "output-available" ||
    p.output == null ||
    p.errorText
  )
    return false;
  if (typeof p.output === "object") {
    const o = p.output as Record<string, unknown>;
    if (
      o.error ||
      o.success === false ||
      (typeof o.exitCode === "number" && o.exitCode !== 0) ||
      o.status === "failed" ||
      o.status === "error"
    )
      return false;
    const r = o.result as Record<string, unknown> | undefined;
    if (
      r &&
      (r.error ||
        r.success === false ||
        (typeof (r.exited as { exitCode?: unknown } | undefined)?.exitCode ===
          "number" &&
          (r.exited as { exitCode: number }).exitCode !== 0) ||
        (typeof r.exitCode === "number" && r.exitCode !== 0))
    )
      return false;
  }
  return true;
}

export function serializeGoalEvidence(part: unknown): string {
  const serialized = JSON.stringify(part);
  return serialized.length <= 4000
    ? serialized
    : "[TRUNCATED: use a smaller verification result] " +
        serialized.slice(-3900);
}

export function validGoalRequest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (
    request.expectedGeneration !== undefined &&
    (typeof request.expectedGeneration !== "number" ||
      !Number.isSafeInteger(request.expectedGeneration) ||
      request.expectedGeneration < 0)
  )
    return false;
  if (request.action === "start") return validGoalStart(request);
  return request.action === "resume";
}

export function resolveGoalOutcome(args: {
  noProgressRuns: number;
  checkpoint?: GoalCheckpoint;
  allCriteriaVerified: boolean;
  finishReason?: string;
  canceled: boolean;
  failed: boolean;
  usageExhausted: boolean;
  judgment?: GoalJudgment;
}): GoalState {
  // A boundary always wins over a model's pending completion claim.
  // Canceling a work slice pauses the goal; explicit stop/clear controls
  // persist their own terminal state before this resolver is reached.
  if (args.canceled) return "paused";
  if (
    args.usageExhausted ||
    ["budget-exhausted", "agent-run-spend-cap"].includes(
      args.finishReason ?? "",
    )
  )
    return "usage_exhausted";
  if (args.failed || args.finishReason === "error") return "failed";
  if (args.judgment?.verdict === "blocked") return "blocked";
  if (args.checkpoint?.outcome === "needs_input") return "needs_input";
  if (args.checkpoint?.outcome === "blocked") return "blocked";
  const boundary =
    args.finishReason &&
    args.finishReason !== "stop" &&
    args.finishReason !== "tool-calls";
  if (
    !boundary &&
    args.checkpoint?.outcome === "achieved" &&
    args.allCriteriaVerified &&
    args.judgment?.verdict === "done"
  )
    return "achieved";
  if (args.noProgressRuns >= 2) return "blocked";
  if (args.checkpoint?.outcome === "wait" && args.checkpoint.waitSeconds)
    return "waiting";
  return "queued";
}

/** Verification gates use the existing approved terminal path, never a new shell runner. */
export function verificationGatePassed(
  parts: readonly unknown[],
  command?: string,
): boolean {
  if (!command?.trim()) return true;
  type TerminalPart = {
    type?: string;
    toolCallId?: string;
    input?: { command?: string; session?: string; action?: string };
    output?: {
      result?: {
        exitCode?: number;
        exited?: { exitCode?: number };
        session?: string;
      };
    };
  };
  const terminalParts = parts.map((part) =>
    part && typeof part === "object" ? (part as TerminalPart) : {},
  );
  const index = terminalParts.findLastIndex(
    (p) =>
      p.type === "tool-run_terminal_cmd" &&
      p.input?.command?.trim() === command.trim(),
  );
  if (index < 0) return false;
  const p = terminalParts[index];
  if (!p.toolCallId || !isGoalEvidencePart(p, p.toolCallId)) return false;
  const result = p.output?.result;
  if (result?.exitCode !== undefined || result?.exited)
    return (result.exitCode ?? result.exited?.exitCode) === 0;
  if (!result?.session) return false;
  const latestWait = terminalParts
    .slice(index + 1)
    .findLast(
      (n) =>
        n.type === "tool-interact_with_terminal" &&
        n.input?.session === result.session &&
        n.input?.action === "wait",
    );
  return (
    !!latestWait?.toolCallId &&
    isGoalEvidencePart(latestWait, latestWait.toolCallId) &&
    (latestWait.output?.result?.exitCode ??
      latestWait.output?.result?.exited?.exitCode) === 0
  );
}
