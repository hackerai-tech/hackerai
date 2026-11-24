import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { logger, runs, schemaTask } from "@trigger.dev/sdk";
import { generateText, Output } from "ai";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { myProvider } from "@/lib/ai/providers";
import { createServiceConvexClient } from "@/lib/db/service-client";
import { signServiceArgs } from "@/lib/db/service-proof";
import { encryptAbuseEvidence } from "@/lib/abuse/evidence-crypto";
import {
  ACQUISITION_LINK_TTL_S,
  egressAbuseReviewGate,
  readAcquisitionLinks,
  type AcquisitionLink,
} from "@/lib/abuse/egress-review-context";
import {
  cooldownSuppresses,
  grantReviewCooldown,
  readReviewCooldowns,
  type ReviewCooldown,
} from "@/lib/abuse/egress-review-cooldown";
import {
  accountActivityReason,
  buildCaseRecord,
  decideAccountActivity,
  decideReview,
  EGRESS_ACCOUNT_ACTIVITY_PROMPT_VERSION,
  EGRESS_REVIEW_PROMPT_VERSION,
  egressReviewClassificationSchema,
  prepareReview,
  REVIEW_WINDOW_MINUTES,
  reviewCaseKey,
  reviewDigest,
  reviewReference,
  reviewWindowStart,
  type AccountActivityChat,
  type AccountActivityReview,
  type EgressReviewClassification,
  type EgressReviewObservation,
  type ManualReason,
  type ReviewDecision,
  type ReviewEvidence,
  type ReviewItems,
  type CaseEnforcementRecord,
} from "@/lib/abuse/egress-review";
import {
  buildIntentConfirmationPrompt,
  decideEnforcement,
  EGRESS_INTENT_PROMPT_VERSION,
  egressAbuseEnforcementGate,
  egressIntentConfirmationSchema,
  ENFORCEMENT_POLICY_VERSION,
  keepActiveReason,
  type EnforcementCheck,
} from "@/lib/abuse/egress-enforcement";
import {
  VERIFIED_EGRESS_BLOCK_SCOPE,
  egressEvidenceFingerprint,
  type BlockRefusal,
  type EnforcementDecision,
  type EnforcementReason,
  type ReviewCoverageState,
} from "@/lib/abuse/egress-outcomes";
import {
  ATTRIBUTION_REF,
  resolveAttribution,
} from "@/lib/cloud-network/egress-attribution";
import {
  egressBurstThreshold,
  readTelemetryMinutes,
  TELEMETRY_REGIONS,
} from "@/lib/cloud-network/egress-telemetry";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  assertResearchPromptIsSafe,
  USER_RESEARCH_MODEL_KEY,
  USER_RESEARCH_PROVIDER_OPTIONS,
} from "@/lib/research/user-research";

// Defensive triage of one verified attributed burst. It reads the exact linked
// run's stored evidence, and either skips clearly corroborated legitimate work
// or creates one encrypted operator case. Without a linked run it attaches
// bounded, advisory account activity to a manual case. Only when the existing
// policy finds concerning, unauthorized activity on complete exact-run
// evidence does a second, narrow confirmation check for explicit harmful
// intent; a confirmed decision blocks the account through the separately keyed
// and switched enforcement mutation, or is recorded as pending enforcement.
// Every other review keeps the account active. It never sends mail itself,
// cancels runs or contacts a sandbox, and its payload, output and logs carry
// only opaque references and closed enums.

/** Matches the burst alert: collectors seal a minute after it ends. */
const SETTLE_MINUTES = 2;
const MAX_LINKS = 16;
export const EGRESS_REVIEW_MAX_ATTEMPTS = 4;

export const egressAbuseReviewPayloadSchema = z
  .object({
    region: z.enum(TELEMETRY_REGIONS),
    owner: z.string().regex(ATTRIBUTION_REF),
    minute: z.number().int().positive(),
  })
  .strict();
export type EgressAbuseReviewPayload = z.infer<
  typeof egressAbuseReviewPayloadSchema
>;

/**
 * Closed detail for why a review stopped where it did. Diagnostics only: it
 * never changes a decision and carries no identifiers, content or provider
 * errors, only these enums and small counts.
 */
export type ReviewDiagnosticDetail =
  // acquisition_incomplete
  | "multiple_sandboxes"
  | "link_history_trimmed"
  | "link_history_invalid"
  | "too_many_runs"
  // multiple_runs
  | "competing_links"
  | "concurrent_root_run"
  | "concurrent_run_evidence"
  // account_runs_unverified
  | "root_history_settling"
  | "root_lookup_failed"
  | "root_page_limit"
  | "root_page_invalid"
  | "root_row_mismatch"
  | "root_timing_invalid"
  | "selected_run_absent"
  | "selected_run_not_started"
  | "selected_run_outside_burst"
  // observation_incomplete
  | "run_overlap_unknown"
  | "evidence_run_mismatch"
  | "evidence_incomplete"
  | "evidence_gaps"
  // evidence_unavailable and subagent_unresolved
  | "linked_chat_unavailable"
  | "subagent_link"
  | "subagent_overlap";
export type ObservationGap =
  | "no_user_messages"
  | "run_active"
  | "history_truncated"
  | "user_messages_omitted"
  | "commands_omitted"
  | "incomplete_tool_calls"
  | "prompt_items_truncated"
  | "prompt_items_omitted";
export type ReviewDiagnostic = {
  detail?: ReviewDiagnosticDetail;
  /** Verified sandboxes counted in the burst minute. */
  sandboxes?: number;
  /** Raw link records stored for the workspace. */
  storedLinks?: number;
  /** Distinct runs linked before the burst ended. */
  runLinks?: number;
  /** Linked parent runs that could have been active during the burst. */
  plausibleRuns?: number;
  /** Linked runs whose chat was unavailable. */
  unavailableLinks?: number;
  gaps?: ObservationGap[];
  /** An active cooldown was bypassed, or could not be checked. */
  cooldown?: "bypassed" | "unavailable" | "window_unsettled";
  /** What a corroborated legitimate decision did to the cooldown. */
  cooldownGrant?: "granted" | "kept" | "failed";
};

export type EgressAbuseReviewResult =
  | { status: "disabled" }
  | { status: "skipped"; reason: "burst_not_verified" }
  // A routine burst from an account recently cleared on exact-run evidence.
  | { status: "skipped"; reason: "cooldown_active" }
  | {
      status: "completed";
      outcome: ReviewDecision["outcome"];
      reason: ReviewDecision["reason"];
      case: "created" | "existing" | "none";
      enforcement: EnforcementDecision;
      enforcementReason: EnforcementReason;
      /** Set only for a block applied by this attempt. */
      notice?: "queued" | "deduplicated";
      diagnostic?: ReviewDiagnostic;
    }
  // The window's case already existed and was left unchanged. This attempt's
  // decision was not stored, so the receipt does not report one.
  | { status: "preserved"; case: "existing" };

/** Matches the `user_` tag both Agent entry points put on root runs. */
const AGENT_TASK = "agent-long";
const ROOT_RUN_PAGE = 50;
const MAX_ROOT_PAGES = 4;
/** Allow time for Trigger's run history to catch up before evaluating overlap. */
const ROOT_HISTORY_SETTLE_MS = 20 * 60_000;
/** Run timing comes from Trigger's clock, not the collectors'. */
const CLOCK_SKEW_MS = 60_000;
const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

const timeOf = (value: unknown) =>
  value instanceof Date && Number.isFinite(value.getTime())
    ? value.getTime()
    : undefined;

/**
 * Lists the account's Agent root runs created by the end of the burst in this
 * worker's own environment. The provider can return metadata, which this
 * check discards. `sole` requires the selected run in the settled history
 * with matching identity and usable timing, and every other listed run proven
 * to have started after or finished before the burst, or to have ended
 * without ever starting. Anything else is `concurrent` or `unverified`.
 */
type RootRunCheck =
  | { status: "sole" | "concurrent" }
  | { status: "unverified"; detail: ReviewDiagnosticDetail };

async function checkAccountRootRuns(
  userId: string,
  runId: string,
  burst: { burstStart: number; burstEnd: number },
): Promise<RootRunCheck> {
  const unverified = (detail: ReviewDiagnosticDetail) =>
    ({ status: "unverified", detail }) as const;
  const tag = `user_${userId}`;
  const latest = burst.burstEnd + CLOCK_SKEW_MS;
  const earliest = burst.burstStart - CLOCK_SKEW_MS;
  let rows: Array<{
    id: string;
    status: string;
    taskIdentifier: string;
    tags: string[];
    startedAt?: Date;
    finishedAt?: Date;
  }>;
  let failure: ReviewDiagnosticDetail = "root_lookup_failed";
  try {
    // The SDK adds filters, including the account tag, to its trace spans.
    rows = await context.with(suppressTracing(context.active()), async () => {
      let page = await runs.list({
        taskIdentifier: AGENT_TASK,
        tag,
        // Use the available history rather than the API's default window.
        from: 1,
        to: latest,
        limit: ROOT_RUN_PAGE,
      });
      const history = [...page.data];
      for (let read = 1; page.hasNextPage(); read++) {
        if (read >= MAX_ROOT_PAGES) {
          failure = "root_page_limit";
          throw new Error("Run history page limit");
        }
        if (page.data.length > ROOT_RUN_PAGE) {
          failure = "root_page_invalid";
          throw new Error("Invalid page size");
        }
        page = await page.getNextPage();
        history.push(...page.data);
      }
      if (page.data.length > ROOT_RUN_PAGE) {
        failure = "root_page_invalid";
        throw new Error("Invalid page size");
      }
      return history;
    });
  } catch {
    // The error can echo request details; only the closed reason is kept.
    return unverified(failure);
  }
  let selected = false;
  let concurrent = false;
  for (const row of rows) {
    if (row.taskIdentifier !== AGENT_TASK || !row.tags?.includes(tag))
      return unverified("root_row_mismatch");
    const startedAt = timeOf(row.startedAt);
    const finishedAt = timeOf(row.finishedAt);
    if (
      startedAt !== undefined &&
      finishedAt !== undefined &&
      finishedAt < startedAt
    )
      return unverified("root_timing_invalid");
    if (row.id === runId) {
      // Trigger must agree that the selected run could overlap the burst.
      if (startedAt === undefined)
        return unverified("selected_run_not_started");
      if (
        startedAt > latest ||
        (finishedAt !== undefined && finishedAt < earliest)
      )
        return unverified("selected_run_outside_burst");
      selected = true;
      continue;
    }
    const disjoint =
      (startedAt !== undefined && startedAt > latest) ||
      (finishedAt !== undefined && finishedAt < earliest) ||
      (startedAt === undefined && TERMINAL_RUN_STATUSES.has(row.status));
    if (!disjoint) concurrent = true;
  }
  if (!selected) return unverified("selected_run_absent");
  return { status: concurrent ? "concurrent" : "sole" };
}

/** Retried by Trigger while a still-active run's evidence may grow. */
class EgressReviewPendingError extends Error {
  constructor() {
    super("Egress abuse review evidence is still being recorded");
    this.name = "EgressReviewPendingError";
  }
}

function reviewClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  const serviceKey = process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY?.trim();
  if (!convexUrl || !serviceKey)
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL and CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY are required",
    );
  return {
    client: createServiceConvexClient(convexUrl),
    serviceKey,
    convexUrl,
  };
}

/** False when the existing privacy guard rejects the prepared prompt. */
function passesPrivacyGuard(prompt: string) {
  try {
    assertResearchPromptIsSafe(prompt, (category) => {
      logger.warn("Egress abuse review privacy guard rejected evidence", {
        category,
      });
    });
    return true;
  } catch {
    return false;
  }
}

/** Structured enums and indices only: no tools, no telemetry of content. */
async function classifyEvidence<T = EgressReviewClassification>(
  prompt: string,
  schema: z.ZodType<T> = egressReviewClassificationSchema as never,
): Promise<T | "classifier_invalid" | "classifier_unavailable"> {
  try {
    const result = await generateText({
      model: myProvider.languageModel(USER_RESEARCH_MODEL_KEY),
      output: Output.object({ schema }),
      providerOptions: USER_RESEARCH_PROVIDER_OPTIONS,
      experimental_telemetry: { isEnabled: false },
      temperature: 0,
      maxOutputTokens: 2_000,
      maxRetries: 1,
      prompt,
    });
    const parsed = schema.safeParse(result.output);
    return parsed.success ? parsed.data : "classifier_invalid";
  } catch {
    return "classifier_unavailable";
  }
}

/**
 * Advisory review of one recent chat that is not linked to the burst. Each
 * chat is prepared and classified on its own, so one chat's messages never
 * authorize or explain another chat's commands.
 */
async function assessAccountChat(
  chat: ReviewItems & { chatId: string; runIds: string[] },
  burst: { start: number; end: number },
): Promise<{ assessment: AccountActivityChat; classified: boolean }> {
  const base = {
    chatId: chat.chatId,
    runIds: chat.runIds,
    coverage: chat.coverage,
    classification: null,
    locators: { commands: [], messages: [] },
  };
  // Started commands corroborate user text, and text gives commands context.
  if (!chat.userMessages.length)
    return {
      assessment: { ...base, finding: "no_user_context" },
      classified: false,
    };
  const prepared = prepareReview(chat, burst, "account_activity");
  if (!passesPrivacyGuard(prepared.prompt))
    return {
      assessment: { ...base, finding: "privacy_guard" },
      classified: false,
    };
  const classification = await classifyEvidence(prepared.prompt);
  if (typeof classification === "string")
    return {
      assessment: { ...base, finding: classification },
      classified: true,
    };
  const decision = decideAccountActivity(classification, chat, prepared);
  return {
    assessment: {
      ...base,
      finding: decision.finding,
      classification: {
        verdict: classification.verdict,
        activity: classification.activity,
        authorization: classification.authorization,
      },
      locators: {
        commands: decision.commands.map(
          (index) => prepared.commandLocators[index],
        ),
        messages: decision.messages.map(
          (index) => prepared.messageLocators[index],
        ),
      },
    },
    classified: true,
  };
}

export async function runEgressAbuseReview(
  payload: EgressAbuseReviewPayload,
  attempt: { number: number; max: number } = {
    number: EGRESS_REVIEW_MAX_ATTEMPTS,
    max: EGRESS_REVIEW_MAX_ATTEMPTS,
  },
): Promise<EgressAbuseReviewResult> {
  const diagnostic: ReviewDiagnostic = {};
  const result = await reviewBurst(payload, attempt, diagnostic);
  // Explains an abstention or a clearance; other outcomes keep their output.
  return result.status === "completed" &&
    result.outcome !== "authorization_request" &&
    Object.keys(diagnostic).length
    ? { ...result, diagnostic: { ...diagnostic } }
    : result;
}

/** The strongest verified minute and whether the settled window has gaps. */
async function windowPeak(
  redis: NonNullable<ReturnType<typeof createRedisClient>>,
  region: EgressAbuseReviewPayload["region"],
  owner: string,
  windowStart: number,
  latestSettled: number,
) {
  const last = Math.min(windowStart + REVIEW_WINDOW_MINUTES - 1, latestSettled);
  const minutes = Array.from(
    { length: Math.max(0, last - windowStart + 1) },
    (_, index) => windowStart + index,
  );
  const records = await readTelemetryMinutes(redis, region, minutes);
  let peak = { minute: windowStart, connections: 0 };
  let complete = records.length === minutes.length;
  for (const [index, record] of records.entries()) {
    if (
      !record ||
      !record.complete ||
      record.droppedEvents ||
      record.droppedBatches
    ) {
      complete = false;
      continue;
    }
    const connections = record.counts
      .filter(([ref]) => ref === owner)
      .reduce((sum, [, , n]) => sum + n, 0);
    if (connections > peak.connections)
      peak = { minute: minutes[index], connections };
  }
  return { peak, complete };
}

async function reviewBurst(
  payload: EgressAbuseReviewPayload,
  attempt: { number: number; max: number },
  diagnostic: ReviewDiagnostic,
  followEscalation = true,
): Promise<EgressAbuseReviewResult> {
  if (egressAbuseReviewGate() !== "on") return { status: "disabled" };
  const threshold = egressBurstThreshold();
  if (threshold === null)
    throw new Error("Egress review threshold is unavailable");
  const { region, owner, minute } =
    egressAbuseReviewPayloadSchema.parse(payload);
  const redis = createRedisClient();
  if (!redis) throw new Error("Egress review store is unavailable");
  const { client, serviceKey, convexUrl } = reviewClient();
  const now = Date.now();
  if (minute > Math.floor(now / 60_000) - SETTLE_MINUTES)
    throw new EgressReviewPendingError();
  const finalAttempt = attempt.number >= attempt.max;

  const windowStart = reviewWindowStart(minute);
  const caseKey = reviewCaseKey(region, owner, windowStart);
  const reference = reviewReference(caseKey);
  const burst = {
    burstStart: minute * 60_000,
    burstEnd: (minute + 1) * 60_000,
  };
  const observation: EgressReviewObservation = {
    region,
    ownerRef: owner,
    burstMinute: minute,
    windowStart,
    connections: 0,
    workspaces: 0,
  };
  let userId: string | undefined;
  let sandboxIds: string[] | undefined;

  type CaseDetails = Pick<
    Parameters<typeof buildCaseRecord>[0],
    | "run"
    | "coverage"
    | "classification"
    | "locators"
    | "model"
    | "accountActivity"
    | "enforcement"
  > & { promptIncomplete?: boolean };
  const digest = reviewDigest(caseKey);
  const encryptRecord = (
    decision: Exclude<ReviewDecision, { outcome: "no_case" }>,
    details: CaseDetails,
  ) =>
    // Encrypted before RPC: native argument errors can echo arguments.
    encryptAbuseEvidence(
      reference,
      buildCaseRecord({
        reference,
        observation,
        decision,
        userId,
        sandboxIds,
        reviewedAt: Date.now(),
        ...details,
      }),
    );
  const buildReceipt = (
    decision: ReviewDecision,
    details: CaseDetails,
    enforcement: {
      decision: Exclude<EnforcementDecision, "block_applied">;
      reason: EnforcementReason;
      refusal?: BlockRefusal;
    },
  ) => {
    const { coverage: run, accountActivity: activity } = details;
    const coverage: ReviewCoverageState = run
      ? !details.promptIncomplete &&
        !run.historyTruncated &&
        !run.userMessagesOmitted &&
        !run.commandsOmitted &&
        !run.incompleteToolCalls &&
        !run.runActive
        ? "complete"
        : "incomplete"
      : activity
        ? activity.status === "read" &&
          !activity.coverage.scanTruncated &&
          !activity.coverage.chatsOmitted
          ? "complete"
          : "incomplete"
        : "not_read";
    return {
      decision: enforcement.decision,
      reason: enforcement.reason,
      reviewReason: decision.reason,
      evidenceMode: activity ? "account_activity" : run ? "exact_run" : "none",
      coverage,
      ...(enforcement.refusal ? { refusal: enforcement.refusal } : {}),
      ...(details.enforcement
        ? { intentKind: details.enforcement.intentKind }
        : {}),
    } as const;
  };
  const persist = async (
    decision: Exclude<ReviewDecision, { outcome: "no_case" }>,
    details: CaseDetails = {},
    enforcement: {
      decision: Exclude<EnforcementDecision, "block_applied">;
      reason: EnforcementReason;
      refusal?: BlockRefusal;
    } = { decision: "keep_active", reason: keepActiveReason(decision) },
  ): Promise<EgressAbuseReviewResult> => {
    const result = await client.mutation(api.egressAbuseReview.recordCase, {
      serviceKey,
      reference,
      digest,
      ciphertext: encryptRecord(decision, details),
      receipt: buildReceipt(decision, details, enforcement),
    });
    if (result.outcome === "existing")
      return { status: "preserved", case: "existing" };
    return {
      status: "completed",
      outcome: decision.outcome,
      reason: decision.reason,
      case: "created",
      enforcement: enforcement.decision,
      enforcementReason: enforcement.reason,
    };
  };
  const manual = (
    reason: ManualReason,
    details?: Parameters<typeof persist>[1],
  ) => persist({ outcome: "manual_review", reason }, details);
  /** Waits for a run's persisted evidence; the last attempt records a manual case. */
  const pending = (
    reason: ManualReason,
    details?: Parameters<typeof persist>[1],
  ) => {
    if (!finalAttempt) throw new EgressReviewPendingError();
    return manual(reason, details);
  };

  // Recheck the alert's input: one settled, complete minute for this owner.
  const [record] = await readTelemetryMinutes(redis, region, [minute]);
  const counts = record?.counts.filter(([ref]) => ref === owner) ?? [];
  observation.connections = counts.reduce((sum, [, , n]) => sum + n, 0);
  observation.workspaces = counts.length;
  if (
    !record ||
    !record.complete ||
    record.droppedEvents ||
    record.droppedBatches ||
    observation.connections < threshold
  )
    return { status: "skipped", reason: "burst_not_verified" };

  // The owner and every counted workspace must be verified.
  const resolved = await resolveAttribution(
    redis,
    region,
    owner,
    counts.map(([, workspace]) => workspace),
  );
  userId = resolved.userId;
  sandboxIds = resolved.sandboxIds;
  if (!userId || resolved.unverifiedWorkspaces > 0 || !sandboxIds.length)
    return manual("attribution_unverified");
  diagnostic.sandboxes = sandboxIds.length;

  // A recent exact-run clearance suppresses routine bursts before any
  // evidence or model call. Any failure to read or compare reviews in full.
  let cooldown: ReviewCooldown | null = null;
  if (followEscalation) {
    try {
      [cooldown] = await readReviewCooldowns(redis, [userId]);
    } catch {
      diagnostic.cooldown = "unavailable";
    }
  }
  if (cooldown && cooldown.digest !== digest) {
    const latestSettled = Math.floor(now / 60_000) - SETTLE_MINUTES;
    const window = await windowPeak(
      redis,
      region,
      owner,
      windowStart,
      latestSettled,
    ).catch(() => null);
    if (
      window &&
      !cooldownSuppresses(
        cooldown,
        Math.max(window.peak.connections, observation.connections),
        threshold,
      )
    ) {
      diagnostic.cooldown = "bypassed";
      const { peak } = window;
      if (peak.connections > observation.connections) {
        // Start from the settled minute that escalated. Its telemetry and
        // attribution are verified independently, and the case key is the same.
        return reviewBurst(
          { ...payload, minute: peak.minute },
          attempt,
          diagnostic,
          false,
        );
      }
    } else if (!window?.complete) {
      // A missing or lossy minute could hide an escalation.
      diagnostic.cooldown = "unavailable";
    } else {
      if (latestSettled >= windowStart + REVIEW_WINDOW_MINUTES - 1)
        return { status: "skipped", reason: "cooldown_active" };
      // Once dispatched, this case has consumed its queue idempotency key.
      // Keep the review alive so a later escalation can still be evaluated.
      if (!finalAttempt) throw new EgressReviewPendingError();
      diagnostic.cooldown = "window_unsettled";
    }
  }

  // One linked run may explain one sandbox. A shared owner does not prove
  // which activity caused a combined burst from multiple sandboxes.
  if (sandboxIds.length !== 1) {
    diagnostic.detail = "multiple_sandboxes";
    return manual("acquisition_incomplete");
  }

  const since = burst.burstStart - ACQUISITION_LINK_TTL_S * 1_000;
  const links = new Map<string, AcquisitionLink>();
  for (const sandboxId of sandboxIds) {
    const read = await readAcquisitionLinks(
      redis,
      region,
      userId,
      sandboxId,
      since,
    );
    diagnostic.storedLinks = read.stored;
    if (!read.complete) {
      diagnostic.detail =
        read.incomplete === "invalid"
          ? "link_history_invalid"
          : "link_history_trimmed";
      return manual("acquisition_incomplete");
    }
    // Each run's latest acquisition before the burst ended; one after it
    // cannot hide an earlier one.
    for (const link of read.links) {
      const key = `${link.kind}|${link.chatId}|${link.runId}`;
      if (
        link.acquiredAt < burst.burstEnd &&
        link.acquiredAt >= (links.get(key)?.acquiredAt ?? -Infinity)
      )
        links.set(key, link);
    }
  }
  if (!links.size) {
    // Nothing links the workspace to a chat. Recent account activity is read
    // once per case as operator context; it never clears the burst, drafts a
    // request, or names a chat as its cause.
    const read = await (async () => {
      const attributionKey = process.env.CONVEX_SERVICE_ROLE_KEY?.trim();
      if (!attributionKey || attributionKey === serviceKey)
        return { status: "unavailable" } as const;
      const subject = { userId, reference, ...burst };
      const proof = await signServiceArgs(
        {
          deployment: convexUrl,
          name: "egressAbuseReview:readAccountActivity",
          type: "query",
        },
        { ...subject, serviceKey: attributionKey },
      );
      return client.query(api.egressAbuseReview.readAccountActivity, {
        ...subject,
        serviceKey,
        attributionProof: String(proof.serviceKey),
      });
    })().catch(() => ({ status: "unavailable" }) as const);
    if (read.status === "case_exists")
      return { status: "preserved", case: "existing" };
    let accountActivity: AccountActivityReview = { status: "unavailable" };
    let classified = false;
    if (read.status === "ok") {
      const chats: AccountActivityChat[] = [];
      for (const chat of read.chats) {
        const result = await assessAccountChat(chat, {
          start: burst.burstStart,
          end: burst.burstEnd,
        });
        chats.push(result.assessment);
        classified ||= result.classified;
      }
      accountActivity = {
        status: "read",
        windowStart: read.windowStart,
        windowEnd: read.windowEnd,
        coverage: read.coverage,
        chats,
      };
    }
    return manual(accountActivityReason(accountActivity), {
      accountActivity,
      ...(classified
        ? {
            model: {
              key: USER_RESEARCH_MODEL_KEY,
              promptVersion: EGRESS_ACCOUNT_ACTIVITY_PROMPT_VERSION,
            },
          }
        : {}),
    });
  }
  diagnostic.runLinks = links.size;
  if (links.size > MAX_LINKS) {
    diagnostic.detail = "too_many_runs";
    return manual("acquisition_incomplete");
  }

  const matches = await Promise.all(
    [...links.values()].map(async (link) => ({
      link,
      status: (
        await client.query(api.egressAbuseReview.matchRun, {
          serviceKey,
          userId: userId!,
          chatId: link.chatId,
          runId: link.runId,
          runKind: link.kind,
          ...burst,
        })
      ).status,
    })),
  );
  const unavailableLinks = matches.filter(
    ({ status }) => status === "unavailable",
  ).length;
  if (unavailableLinks) {
    diagnostic.detail = "linked_chat_unavailable";
    diagnostic.unavailableLinks = unavailableLinks;
    return manual("evidence_unavailable");
  }
  if (
    matches.some(
      ({ link, status }) => link.kind === "subagent" && status !== "disjoint",
    )
  ) {
    diagnostic.detail = "subagent_link";
    return manual("subagent_unresolved");
  }
  const plausible = matches.filter(
    ({ link, status }) => link.kind === "parent" && status !== "disjoint",
  );
  diagnostic.plausibleRuns = plausible.length;
  if (plausible.length > 1) {
    diagnostic.detail = "competing_links";
    return manual("multiple_runs");
  }
  if (!plausible.length) return manual("no_matching_run");
  const [{ link, status }] = plausible;
  const run = { chatId: link.chatId, runId: link.runId };
  if (status !== "overlaps") {
    diagnostic.detail = "run_overlap_unknown";
    return pending("observation_incomplete", { run });
  }
  if (now - burst.burstEnd < ROOT_HISTORY_SETTLE_MS) {
    diagnostic.detail = "root_history_settling";
    return pending("account_runs_unverified", { run });
  }
  // A competing run's link may be missing or expired; rule out every other
  // root run of the account before reading this run's evidence.
  const roots = await checkAccountRootRuns(userId, link.runId, burst);
  if (roots.status === "concurrent") {
    diagnostic.detail = "concurrent_root_run";
    return manual("multiple_runs", { run });
  }
  if (roots.status === "unverified") {
    diagnostic.detail = roots.detail;
    return manual("account_runs_unverified", { run });
  }

  const read = await client.query(api.egressAbuseReview.readRunEvidence, {
    serviceKey,
    userId,
    ...run,
    ...burst,
  });
  if (read.status === "unavailable") {
    if (read.reason === "subagent_overlap") {
      diagnostic.detail = "subagent_overlap";
      return manual("subagent_unresolved", { run });
    }
    if (read.reason === "concurrent_run") {
      diagnostic.detail = "concurrent_run_evidence";
      return manual("multiple_runs", { run });
    }
    diagnostic.detail =
      read.reason === "run_mismatch"
        ? "evidence_run_mismatch"
        : "evidence_incomplete";
    return pending("observation_incomplete", { run });
  }
  const evidence: ReviewEvidence = read;
  const runDetails = {
    ...run,
    runStart: evidence.runStart,
    runEnd: evidence.runEnd,
  };
  if (evidence.coverage.runActive && !finalAttempt)
    throw new EgressReviewPendingError();
  if (!evidence.commands.length)
    return manual("no_command_evidence", {
      run: runDetails,
      coverage: evidence.coverage,
    });

  const prepared = prepareReview(evidence, {
    start: burst.burstStart,
    end: burst.burstEnd,
  });
  const base = {
    run: runDetails,
    coverage: evidence.coverage,
    promptIncomplete:
      prepared.itemsTruncated ||
      prepared.itemsOmitted ||
      !evidence.userMessages.length,
  };
  const { coverage } = evidence;
  const gaps = (
    [
      ["no_user_messages", !evidence.userMessages.length],
      ["run_active", coverage.runActive],
      ["history_truncated", coverage.historyTruncated],
      ["user_messages_omitted", coverage.userMessagesOmitted],
      ["commands_omitted", coverage.commandsOmitted],
      ["incomplete_tool_calls", coverage.incompleteToolCalls],
      ["prompt_items_truncated", prepared.itemsTruncated],
      ["prompt_items_omitted", prepared.itemsOmitted],
    ] as const
  )
    .filter(([, present]) => present)
    .map(([gap]) => gap);
  if (gaps.length) {
    diagnostic.detail = "evidence_gaps";
    diagnostic.gaps = [...gaps];
    return manual("observation_incomplete", base);
  }
  if (!passesPrivacyGuard(prepared.prompt))
    return manual("privacy_guard", base);

  const model = {
    key: USER_RESEARCH_MODEL_KEY,
    promptVersion: EGRESS_REVIEW_PROMPT_VERSION,
  };
  const classification = await classifyEvidence(prepared.prompt);
  if (typeof classification === "string")
    return manual(classification, { ...base, model });

  const decision = decideReview(classification, evidence, prepared);
  if (decision.outcome === "no_case") {
    try {
      await client.mutation(api.egressAbuseReview.recordReceipt, {
        serviceKey,
        digest,
        ...buildReceipt(decision, base, {
          decision: "keep_active",
          reason: "legitimate_corroborated",
        }),
        caseOutcome: "none",
      });
    } catch {
      logger.warn("Egress abuse review receipt was not recorded", {
        decision: "keep_active",
      });
    }
    // Only this complete, corroborated exact-run decision grants a cooldown.
    try {
      diagnostic.cooldownGrant = await grantReviewCooldown(redis, userId, {
        peak: observation.connections,
        digest,
      });
    } catch {
      diagnostic.cooldownGrant = "failed";
    }
    return {
      status: "completed",
      outcome: "no_case",
      reason: decision.reason,
      case: "none",
      enforcement: "keep_active",
      enforcementReason: "legitimate_corroborated",
    };
  }
  const { commands, messages, ...outcome } = decision;
  const locate = (cited: { commands: number[]; messages: number[] }) => ({
    commands: cited.commands.map((index) => prepared.commandLocators[index]),
    messages: cited.messages.map((index) => prepared.messageLocators[index]),
  });
  const details: CaseDetails = {
    ...base,
    model,
    classification: {
      verdict: classification.verdict,
      activity: classification.activity,
      authorization: classification.authorization,
    },
    locators: locate({ commands, messages }),
  };
  if (outcome.outcome !== "authorization_request")
    return persist(outcome, details);

  // The high-risk subset: a separate, narrow confirmation of explicit
  // harmful intent over the same scrubbed evidence and indices.
  const confirmationPrompt = buildIntentConfirmationPrompt(prepared);
  let check: EnforcementCheck = { block: false, reason: "inconclusive" };
  if (passesPrivacyGuard(confirmationPrompt)) {
    const confirmation = await classifyEvidence(
      confirmationPrompt,
      egressIntentConfirmationSchema,
    );
    if (typeof confirmation !== "string")
      check = decideEnforcement(confirmation, prepared, {
        ...decision,
        activity: classification.activity,
        runStart: evidence.runStart,
      });
  }
  if (!check.block)
    return persist(outcome, details, {
      decision: "keep_active",
      reason: check.reason,
    });

  const blockRecord = (
    status: CaseEnforcementRecord["decision"],
    reason: EnforcementReason,
    refusal?: BlockRefusal,
  ): CaseEnforcementRecord => ({
    decision: status,
    reason,
    ...(refusal ? { refusal } : {}),
    intentKind: check.intentKind,
    policyVersion: ENFORCEMENT_POLICY_VERSION,
    promptVersion: EGRESS_INTENT_PROMPT_VERSION,
    locators: locate(check),
  });
  const pendingBlock = (reason: EnforcementReason, refusal?: BlockRefusal) =>
    persist(
      outcome,
      {
        ...details,
        enforcement: blockRecord("enforcement_pending", reason, refusal),
      },
      { decision: "enforcement_pending", reason, refusal },
    );
  if (egressAbuseEnforcementGate() !== "on")
    return pendingBlock("enforcement_disabled");
  const enforcementKey =
    process.env.CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY?.trim();
  if (
    !enforcementKey ||
    enforcementKey === serviceKey ||
    enforcementKey === process.env.CONVEX_SERVICE_ROLE_KEY?.trim()
  )
    return pendingBlock("enforcement_unavailable");
  const located = locate(check);
  let applied;
  try {
    const inputs = {
      reference,
      digest,
      ciphertext: encryptRecord(outcome, {
        ...details,
        enforcement: blockRecord("block_applied", "harmful_intent_confirmed"),
      }),
      userId: userId!,
      chatId: run.chatId,
      runId: run.runId,
      ...burst,
      policyVersion: ENFORCEMENT_POLICY_VERSION,
      intentKind: check.intentKind,
      messageIds: located.messages.map(({ messageId }) => messageId),
      commands: located.commands,
      evidenceFingerprint: await egressEvidenceFingerprint(evidence),
    };
    const proof = await signServiceArgs(
      {
        deployment: convexUrl,
        name: VERIFIED_EGRESS_BLOCK_SCOPE,
        type: "mutation",
      },
      { ...inputs, serviceKey },
    );
    applied = await client.mutation(api.egressAbuseEnforcement.applyBlock, {
      ...inputs,
      serviceKey: enforcementKey,
      reviewProof: String(proof.serviceKey),
    });
  } catch (error) {
    // A lost response may have committed: a retry returns `existing_block`,
    // and a last-attempt fallback finds the case and preserves it.
    if (!finalAttempt && !(error instanceof ConvexError)) throw error;
    return pendingBlock("enforcement_unavailable");
  }
  if (applied.outcome === "refused") {
    if (applied.refusal === "case_exists")
      return { status: "preserved", case: "existing" };
    if (applied.refusal === "enforcement_disabled")
      return pendingBlock("enforcement_disabled");
    return pendingBlock("enforcement_refused", applied.refusal);
  }
  return {
    status: "completed",
    outcome: outcome.outcome,
    reason: outcome.reason,
    case: applied.outcome === "applied" ? "created" : "existing",
    enforcement: "block_applied",
    enforcementReason: "harmful_intent_confirmed",
    ...(applied.outcome === "applied" ? { notice: applied.notice } : {}),
  };
}

export const egressAbuseReviewTask = schemaTask({
  id: "egress-abuse-review",
  schema: egressAbuseReviewPayloadSchema,
  machine: { preset: "small-1x" },
  maxDuration: 5 * 60,
  // Retries wait for an active run's evidence to be persisted; the last
  // attempt records a manual case instead of waiting again.
  retry: {
    maxAttempts: EGRESS_REVIEW_MAX_ATTEMPTS,
    minTimeoutInMs: 5 * 60_000,
    maxTimeoutInMs: 20 * 60_000,
    factor: 2,
  },
  queue: { name: "egress-abuse-review", concurrencyLimit: 2 },
  run: async (payload, { ctx }) => {
    const result = await runEgressAbuseReview(payload, {
      number: ctx.attempt.number,
      max: EGRESS_REVIEW_MAX_ATTEMPTS,
    });
    logger.info(
      "Egress abuse review finished",
      result.status === "completed"
        ? {
            outcome: result.outcome,
            reason: result.reason,
            case: result.case,
            enforcement: result.enforcement,
            enforcementReason: result.enforcementReason,
            ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
          }
        : result.status === "preserved"
          ? { status: result.status, case: result.case }
          : result.status === "skipped"
            ? { status: result.status, reason: result.reason }
            : { status: result.status },
    );
    return result;
  },
});
