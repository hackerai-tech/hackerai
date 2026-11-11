import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { encryptAbuseEvidence } from "@/lib/abuse/evidence-crypto";
import { abuseEvidenceKeyring } from "@/lib/abuse/keyring";
import {
  isDesktopPreference,
  isEnvironmentPreference,
} from "@/lib/sandbox/environment";
import {
  redactSensitiveErrorMessage,
  stripControlSequencesFromErrorMessage,
} from "@/lib/utils/error-redaction";
import {
  assertOperationLive,
  startTriggerOperation,
  type TriggerOperation,
} from "@/lib/abuse/trigger-response";

// Operator workflow for confirmed reports, including reports received after
// the historical run completed. No server-only imports: the CLI runs in Node.

export type ResponseConvex = Pick<ConvexHttpClient, "query" | "mutation">;
export type TriggerRun = {
  status: string;
  taskIdentifier?: string;
  payload?: unknown;
};
export type AbuseResponseDeps = {
  convex: ResponseConvex;
  serviceKey: string;
  convexUrl: string;
};
/** Each call is bounded and aborted by its operation's signal and deadline. */
export type AbuseTriggerDeps = {
  retrieveRun: (
    runId: string,
    operation: TriggerOperation,
  ) => Promise<TriggerRun>;
  cancelRun: (runId: string, operation: TriggerOperation) => Promise<unknown>;
  closeApprovalSession: (
    sessionId: string,
    reason: string,
    operation: TriggerOperation,
  ) => Promise<unknown>;
};
/** A server-verified, renewed lease, and the bounded budget it grants. */
export type ResponseCheckpoint = () => Promise<
  TriggerOperation & { dispose: () => void }
>;

/** Fixed codes plus schema field paths only; never input values. */
export class AbuseResponseInputError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "credential_in_note"
      | "historical_run_unavailable"
      | "historical_run_mismatch",
    readonly fields: string[] = [],
  ) {
    super(code);
  }
}

const TERMINAL = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);
const MAX_DISCOVERY_CALLS = 40;

const reference = z.string().regex(/^AB-[a-f0-9-]{36}$/);
const identifier = z.string().trim().min(1).max(160);
const note = z.string().trim().min(20).max(6000);
const text = (max: number) => z.string().trim().max(max).default("");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const subject = z
  .object({
    userId: identifier,
    chatId: identifier,
    runId: z
      .string()
      .regex(/^run_[a-zA-Z0-9]+$/)
      .optional(),
    transport: z.enum(["cloud", "local", "desktop"]),
    environmentId: z.uuid().optional(),
  })
  .strict();

export const abuseImportInput = z
  .object({
    operator: identifier,
    reference,
    kind: z.enum(["abuse", "appeal"]),
    receivedAt: z.iso.datetime({ offset: true }),
    report: z
      .object({
        contact: z.email().max(254).optional(),
        target: text(500),
        occurredAt: text(160),
        description: note,
        sourceIp: text(120),
        sourcePort: text(5),
        protocol: text(40),
        evidence: text(6000),
      })
      .strict(),
  })
  .strict();
// Plan, status and retry ignore the apply-only fields of the same case file.
export const abusePlanInput = z.object({
  operator: identifier,
  reference,
  subject,
});
export const abuseReferenceInput = z.object({
  operator: identifier,
  reference,
});
export const abuseApplyInput = z
  .object({
    operator: identifier,
    reference,
    subject,
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.uuid(),
    review: z
      .object({
        reviewer: identifier,
        reviewDate: date,
        retentionReviewDate: date,
        reason: note,
        verifiedFacts: note,
        evidence: z
          .array(
            z
              .object({
                source: z.string().trim().min(1).max(200),
                observedAt: z.string().trim().min(1).max(80),
                summary: z.string().trim().min(1).max(1000),
              })
              .strict(),
          )
          .max(5)
          .default([]),
      })
      .strict(),
    acknowledge: z
      .object({
        accountRestriction: z.literal(true),
        processStopUnconfirmed: z.literal(true),
      })
      .strict(),
  })
  .strict();

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new AbuseResponseInputError(
      "invalid_input",
      result.error.issues.map((issue) => issue.path.join(".") || "(root)"),
    );
  return result.data;
}

const CREDENTIAL_PATTERNS = [
  /\bhsb_[a-f0-9]{16,}/i,
  /\bhmac1\.\d{13}\.[a-f0-9]{16,}/,
  /\btr_(?:dev|stg|preview|prod)_[A-Za-z0-9]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghs|github_pat|xox[abpr]|e2b|sk_live|rk_live)_[A-Za-z0-9_]{12,}/,
];

/** Conservative: false positives are rephrased, never stored as raw credentials. */
export function containsCredential(value: string): boolean {
  return (
    CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)) ||
    redactSensitiveErrorMessage(value) !==
      stripControlSequencesFromErrorMessage(value)
  );
}

function screen(fields: Record<string, string | undefined>) {
  const flagged = Object.entries(fields)
    .filter(([, value]) => value && containsCredential(value))
    .map(([name]) => name);
  if (flagged.length)
    throw new AbuseResponseInputError("credential_in_note", flagged);
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** Keyed retry identity; every retained key matches during rotation. */
function fingerprints(purpose: string, value: unknown): string[] {
  const config = abuseEvidenceKeyring();
  return [
    config.active,
    ...Object.keys(config.keys).filter((id) => id !== config.active),
  ].map((id) =>
    createHmac("sha256", Buffer.from(config.keys[id], "hex"))
      .update(`${purpose}\0${stableJson(value)}`)
      .digest("hex"),
  );
}

const boundedStatus = (status: unknown) =>
  typeof status === "string" && /^[A-Z_]{1,32}$/.test(status)
    ? status
    : undefined;

/**
 * Corroborate operator-asserted attribution with Trigger's recorded payload.
 * The historical run is evidence only; it never selects a cancellation target.
 */
export async function verifyHistoricalRun(
  deps: AbuseResponseDeps & AbuseTriggerDeps,
  scope: z.output<typeof subject>,
) {
  if (!scope.runId) return { verified: false as const };
  let run: TriggerRun;
  const operation = startTriggerOperation();
  try {
    run = await deps.retrieveRun(scope.runId, operation);
  } catch {
    throw new AbuseResponseInputError("historical_run_unavailable");
  } finally {
    operation.dispose();
  }
  const payload = (run.payload ?? {}) as Record<string, unknown>;
  const preference =
    typeof payload.sandboxPreference === "string"
      ? payload.sandboxPreference
      : "e2b";
  const transport =
    preference === "e2b"
      ? "cloud"
      : isDesktopPreference(preference)
        ? "desktop"
        : "local";
  if (
    run.taskIdentifier !== "agent-long" ||
    payload.userId !== scope.userId ||
    payload.chatId !== scope.chatId ||
    (payload.convexUrl !== undefined && payload.convexUrl !== deps.convexUrl) ||
    transport !== scope.transport ||
    (scope.environmentId !== undefined &&
      (!isEnvironmentPreference(preference) ||
        preference.slice(preference.indexOf(":") + 1) !== scope.environmentId))
  )
    throw new AbuseResponseInputError("historical_run_mismatch");
  return {
    verified: true as const,
    transport,
    ...(boundedStatus(run.status) ? { status: boundedStatus(run.status) } : {}),
  };
}

export async function importReport(deps: AbuseResponseDeps, raw: unknown) {
  const input = parse(abuseImportInput, raw);
  const { report } = input;
  // Every retained report field is screened, including source address/port.
  screen(
    Object.fromEntries(
      Object.entries(report).map(([field, value]) => [
        `report.${field}`,
        value,
      ]),
    ),
  );
  const record = {
    kind: input.kind,
    receivedAt: input.receivedAt,
    report,
  };
  return deps.convex.mutation(api.abuseResponse.importCase, {
    serviceKey: deps.serviceKey,
    actor: input.operator,
    reference: input.reference,
    kind: input.kind,
    ciphertext: encryptAbuseEvidence(input.reference, {
      ...record,
      source: "email_import",
      importedBy: input.operator,
    }),
    digests: fingerprints("abuse-import", record),
  });
}

export async function planResponse(
  deps: AbuseResponseDeps & AbuseTriggerDeps,
  raw: unknown,
) {
  const input = parse(abusePlanInput, raw);
  const historicalRun = await verifyHistoricalRun(deps, input.subject);
  const plan = await deps.convex.query(api.abuseResponse.plan, {
    serviceKey: deps.serviceKey,
    actor: input.operator,
    reference: input.reference,
    ...input.subject,
  });
  return { ...plan, historicalRun };
}

type Target = {
  runId: string;
  kind: "root" | "child";
  chatId: string;
  subagentId?: string;
  approvalSessionId?: string;
  state: string;
};
type TargetOutcome = {
  state: "cancel_requested" | "terminal" | "identity_mismatch" | "unknown";
  triggerStatus?: string;
};

/**
 * Cancel only a run whose Trigger payload matches the server-recorded owner.
 * Unknown outcomes stay retryable; a Trigger status never proves process stop.
 *
 * Every Trigger call runs under a fresh server checkpoint, which verifies the
 * case, restriction and lease after the preceding await. A failed checkpoint
 * throws, so an expired, resolved or superseded operator sends nothing more.
 */
export async function requestCancellation(
  deps: AbuseResponseDeps & AbuseTriggerDeps,
  target: Target,
  userId: string,
  checkpoint: ResponseCheckpoint,
): Promise<TargetOutcome> {
  const observed = (run: TriggerRun) =>
    boundedStatus(run.status)
      ? { triggerStatus: boundedStatus(run.status) }
      : {};
  const operations: Array<{ dispose: () => void }> = [];
  const verified = async () => {
    const operation = await checkpoint();
    operations.push(operation);
    return operation;
  };
  const attempt = async (
    operation: TriggerOperation,
    step: (operation: TriggerOperation) => Promise<unknown>,
  ) => {
    try {
      assertOperationLive(operation);
      await step(operation);
      return true;
    } catch {
      return false;
    }
  };
  try {
    let operation = await verified();
    let run: TriggerRun;
    try {
      run = await deps.retrieveRun(target.runId, operation);
    } catch {
      return { state: "unknown" };
    }
    const payload = (run.payload ?? {}) as Record<string, unknown>;
    const owned =
      (payload.convexUrl === undefined ||
        payload.convexUrl === deps.convexUrl) &&
      (target.kind === "root"
        ? run.taskIdentifier === "agent-long" &&
          payload.userId === userId &&
          payload.chatId === target.chatId
        : run.taskIdentifier === "hackerai-subagent" &&
          target.subagentId !== undefined &&
          payload.subagentId === target.subagentId);
    if (!owned) return { state: "identity_mismatch", ...observed(run) };
    // Cancellation and approval closure are attempted independently. A terminal
    // receipt is final, so it is recorded only after both are confirmed.
    const alreadyTerminal = TERMINAL.has(run.status);
    let canceled = alreadyTerminal;
    if (!alreadyTerminal) {
      operation = await verified();
      canceled = await attempt(operation, (live) =>
        deps.cancelRun(target.runId, live),
      );
    }
    let closed = !target.approvalSessionId;
    if (target.approvalSessionId) {
      const sessionId = target.approvalSessionId;
      operation = await verified();
      closed = await attempt(operation, (live) =>
        deps.closeApprovalSession(sessionId, "reviewed_security_abuse", live),
      );
    }
    if (!canceled || !closed) return { state: "unknown", ...observed(run) };
    if (alreadyTerminal) return { state: "terminal", ...observed(run) };
    try {
      const after = await deps.retrieveRun(target.runId, operation);
      return {
        state: TERMINAL.has(after.status) ? "terminal" : "cancel_requested",
        ...observed(after),
      };
    } catch {
      return { state: "cancel_requested" };
    }
  } finally {
    for (const operation of operations) operation.dispose();
  }
}

async function continueResponse(
  deps: AbuseResponseDeps & AbuseTriggerDeps,
  actor: string,
  referenceId: string,
  operationToken: string,
) {
  const lease = {
    serviceKey: deps.serviceKey,
    actor,
    reference: referenceId,
    operationToken,
  };
  const checkpoint: ResponseCheckpoint = async () => {
    await deps.convex.mutation(api.abuseResponse.checkpoint, lease);
    return startTriggerOperation();
  };
  try {
    let discovered = await deps.convex.mutation(
      api.abuseResponse.discover,
      lease,
    );
    for (
      let call = 1;
      discovered.phase !== "done" && call < MAX_DISCOVERY_CALLS;
      call++
    )
      discovered = await deps.convex.mutation(
        api.abuseResponse.discover,
        lease,
      );
    for (const target of discovered.targets) {
      if (target.state === "terminal") continue;
      const outcome = await requestCancellation(
        deps,
        target,
        discovered.userId,
        checkpoint,
      );
      await deps.convex.mutation(api.abuseResponse.recordTarget, {
        ...lease,
        runId: target.runId,
        ...outcome,
      });
    }
  } catch (error) {
    // Release the lease when storage is reachable; recorded receipts remain.
    await deps.convex
      .mutation(api.abuseResponse.finish, lease)
      .catch(() => undefined);
    throw error;
  }
  return deps.convex.mutation(api.abuseResponse.finish, lease);
}

async function continueIfOwned(
  deps: AbuseResponseDeps & AbuseTriggerDeps,
  actor: string,
  referenceId: string,
  started: {
    outcome: "applied" | "resumed" | "in_progress";
    operationToken?: string;
    response: unknown;
  },
) {
  if (started.outcome === "in_progress" || !started.operationToken)
    return { outcome: started.outcome, response: started.response };
  return {
    outcome: started.outcome,
    response: await continueResponse(
      deps,
      actor,
      referenceId,
      started.operationToken,
    ),
  };
}

/**
 * Persist encrypted attribution/decision and restrict the account in one
 * transaction, then request cancellation of currently active owned work.
 */
export async function applyResponse(
  deps: AbuseResponseDeps & AbuseTriggerDeps,
  raw: unknown,
  operationToken: string,
) {
  const input = parse(abuseApplyInput, raw);
  const { review } = input;
  screen({
    "review.reason": review.reason,
    "review.verifiedFacts": review.verifiedFacts,
    ...Object.fromEntries(
      review.evidence.flatMap((item, index) => [
        [`review.evidence.${index}.source`, item.source],
        [`review.evidence.${index}.observedAt`, item.observedAt],
        [`review.evidence.${index}.summary`, item.summary],
      ]),
    ),
  });
  const historicalRun = await verifyHistoricalRun(deps, input.subject);
  const started = await deps.convex.mutation(api.abuseResponse.apply, {
    serviceKey: deps.serviceKey,
    actor: input.operator,
    reference: input.reference,
    ...input.subject,
    planDigest: input.planDigest,
    requestId: input.requestId,
    requestDigests: fingerprints("abuse-response", input),
    reviewer: review.reviewer,
    reviewDate: review.reviewDate,
    retentionReviewDate: review.retentionReviewDate,
    acknowledgeRestriction: true,
    acknowledgeProcessUnconfirmed: true,
    verifiedFacts: encryptAbuseEvidence(input.reference, {
      type: "verified_fact",
      subject: input.subject,
      facts: review.verifiedFacts,
      evidence: review.evidence,
      historicalRun,
      recordedBy: input.operator,
    }),
    decision: encryptAbuseEvidence(input.reference, {
      type: "decision",
      action: "late_report_restriction",
      reviewer: review.reviewer,
      reviewDate: review.reviewDate,
      retentionReviewDate: review.retentionReviewDate,
      reason: review.reason,
      acknowledge: input.acknowledge,
      recordedBy: input.operator,
    }),
    operationToken,
  });
  return continueIfOwned(deps, input.operator, input.reference, started);
}

export async function retryResponse(
  deps: AbuseResponseDeps & AbuseTriggerDeps,
  raw: unknown,
  operationToken: string,
) {
  const input = parse(abuseReferenceInput, raw);
  const started = await deps.convex.mutation(api.abuseResponse.retry, {
    serviceKey: deps.serviceKey,
    actor: input.operator,
    reference: input.reference,
    operationToken,
  });
  return continueIfOwned(deps, input.operator, input.reference, started);
}

export async function responseStatus(deps: AbuseResponseDeps, raw: unknown) {
  const input = parse(abuseReferenceInput, raw);
  return deps.convex.query(api.abuseResponse.status, {
    serviceKey: deps.serviceKey,
    actor: input.operator,
    reference: input.reference,
  });
}
