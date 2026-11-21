import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { logger, runs, schemaTask } from "@trigger.dev/sdk";
import { generateText, Output } from "ai";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import { myProvider } from "@/lib/ai/providers";
import { createServiceConvexClient } from "@/lib/db/service-client";
import { encryptAbuseEvidence } from "@/lib/abuse/evidence-crypto";
import {
  ACQUISITION_LINK_TTL_S,
  egressAbuseReviewGate,
  readAcquisitionLinks,
  type AcquisitionLink,
} from "@/lib/abuse/egress-review-context";
import {
  buildCaseRecord,
  decideReview,
  EGRESS_REVIEW_PROMPT_VERSION,
  egressReviewClassificationSchema,
  prepareReview,
  reviewCaseKey,
  reviewDigest,
  reviewReference,
  reviewWindowStart,
  type EgressReviewClassification,
  type EgressReviewObservation,
  type ManualReason,
  type ReviewDecision,
  type ReviewEvidence,
} from "@/lib/abuse/egress-review";
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

// Defensive, read-only triage of one verified attributed burst. It reads the
// exact linked run's stored evidence, and either skips clearly corroborated
// legitimate work or creates one encrypted operator case. It never sends
// mail, restricts, blocks, contains, or contacts a sandbox, and its payload,
// output and logs carry only opaque references and closed enums.

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

export type EgressAbuseReviewResult =
  | { status: "disabled" }
  | { status: "skipped"; reason: "burst_not_verified" }
  | {
      status: "completed";
      outcome: ReviewDecision["outcome"];
      reason: ReviewDecision["reason"];
      case: "created" | "none";
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
async function checkAccountRootRuns(
  userId: string,
  runId: string,
  burst: { burstStart: number; burstEnd: number },
): Promise<"sole" | "concurrent" | "unverified"> {
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
        if (read >= MAX_ROOT_PAGES) throw new Error("Run history page limit");
        if (page.data.length > ROOT_RUN_PAGE)
          throw new Error("Invalid page size");
        page = await page.getNextPage();
        history.push(...page.data);
      }
      if (page.data.length > ROOT_RUN_PAGE)
        throw new Error("Invalid page size");
      return history;
    });
  } catch {
    // The error can echo request details; only the closed reason is kept.
    return "unverified";
  }
  let selected = false;
  let concurrent = false;
  for (const row of rows) {
    if (row.taskIdentifier !== AGENT_TASK || !row.tags?.includes(tag))
      return "unverified";
    const startedAt = timeOf(row.startedAt);
    const finishedAt = timeOf(row.finishedAt);
    if (
      startedAt !== undefined &&
      finishedAt !== undefined &&
      finishedAt < startedAt
    )
      return "unverified";
    if (row.id === runId) {
      // Trigger must agree that the selected run could overlap the burst.
      if (
        startedAt === undefined ||
        startedAt > latest ||
        (finishedAt !== undefined && finishedAt < earliest)
      )
        return "unverified";
      selected = true;
      continue;
    }
    const disjoint =
      (startedAt !== undefined && startedAt > latest) ||
      (finishedAt !== undefined && finishedAt < earliest) ||
      (startedAt === undefined && TERMINAL_RUN_STATUSES.has(row.status));
    if (!disjoint) concurrent = true;
  }
  if (!selected) return "unverified";
  return concurrent ? "concurrent" : "sole";
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
  return { client: createServiceConvexClient(convexUrl), serviceKey };
}

export async function runEgressAbuseReview(
  payload: EgressAbuseReviewPayload,
  attempt: { number: number; max: number } = {
    number: EGRESS_REVIEW_MAX_ATTEMPTS,
    max: EGRESS_REVIEW_MAX_ATTEMPTS,
  },
): Promise<EgressAbuseReviewResult> {
  if (egressAbuseReviewGate() !== "on") return { status: "disabled" };
  const threshold = egressBurstThreshold();
  if (threshold === null)
    throw new Error("Egress review threshold is unavailable");
  const { region, owner, minute } =
    egressAbuseReviewPayloadSchema.parse(payload);
  const redis = createRedisClient();
  if (!redis) throw new Error("Egress review store is unavailable");
  const { client, serviceKey } = reviewClient();
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

  const persist = async (
    decision: Exclude<ReviewDecision, { outcome: "no_case" }>,
    details: Pick<
      Parameters<typeof buildCaseRecord>[0],
      "run" | "coverage" | "classification" | "locators" | "model"
    > = {},
  ): Promise<EgressAbuseReviewResult> => {
    const record = buildCaseRecord({
      reference,
      observation,
      decision,
      userId,
      sandboxIds,
      reviewedAt: Date.now(),
      ...details,
    });
    // Encrypted before RPC: native argument errors can echo arguments.
    const ciphertext = encryptAbuseEvidence(reference, record);
    const result = await client.mutation(api.egressAbuseReview.recordCase, {
      serviceKey,
      reference,
      digest: reviewDigest(caseKey),
      ciphertext,
    });
    if (result.outcome === "existing")
      return { status: "preserved", case: "existing" };
    return {
      status: "completed",
      outcome: decision.outcome,
      reason: decision.reason,
      case: "created",
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
  // One linked run may explain one sandbox. A shared owner does not prove
  // which activity caused a combined burst from multiple sandboxes.
  if (sandboxIds.length !== 1) return manual("acquisition_incomplete");

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
    if (!read.complete) return manual("acquisition_incomplete");
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
  if (!links.size) return manual("no_acquisition_link");
  if (links.size > MAX_LINKS) return manual("acquisition_incomplete");

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
  if (matches.some(({ status }) => status === "unavailable"))
    return manual("evidence_unavailable");
  if (
    matches.some(
      ({ link, status }) => link.kind === "subagent" && status !== "disjoint",
    )
  )
    return manual("subagent_unresolved");
  const plausible = matches.filter(
    ({ link, status }) => link.kind === "parent" && status !== "disjoint",
  );
  if (plausible.length > 1) return manual("multiple_runs");
  if (!plausible.length) return manual("no_matching_run");
  const [{ link, status }] = plausible;
  const run = { chatId: link.chatId, runId: link.runId };
  if (status !== "overlaps") return pending("observation_incomplete", { run });
  if (now - burst.burstEnd < ROOT_HISTORY_SETTLE_MS)
    return pending("account_runs_unverified", { run });
  // A competing run's link may be missing or expired; rule out every other
  // root run of the account before reading this run's evidence.
  const roots = await checkAccountRootRuns(userId, link.runId, burst);
  if (roots === "concurrent") return manual("multiple_runs", { run });
  if (roots === "unverified") return manual("account_runs_unverified", { run });

  const read = await client.query(api.egressAbuseReview.readRunEvidence, {
    serviceKey,
    userId,
    ...run,
    ...burst,
  });
  if (read.status === "unavailable") {
    if (read.reason === "subagent_overlap")
      return manual("subagent_unresolved", { run });
    if (read.reason === "concurrent_run")
      return manual("multiple_runs", { run });
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
  const base = { run: runDetails, coverage: evidence.coverage };
  const { coverage } = evidence;
  if (
    !evidence.userMessages.length ||
    coverage.runActive ||
    coverage.historyTruncated ||
    coverage.userMessagesOmitted ||
    coverage.commandsOmitted ||
    coverage.incompleteToolCalls ||
    prepared.itemsTruncated ||
    prepared.itemsOmitted
  )
    return manual("observation_incomplete", base);
  try {
    assertResearchPromptIsSafe(prepared.prompt, (category) => {
      logger.warn("Egress abuse review privacy guard rejected evidence", {
        category,
      });
    });
  } catch {
    return manual("privacy_guard", base);
  }

  const model = {
    key: USER_RESEARCH_MODEL_KEY,
    promptVersion: EGRESS_REVIEW_PROMPT_VERSION,
  };
  let classification: EgressReviewClassification;
  try {
    // Structured enums and indices only: no tools, no telemetry of content.
    const result = await generateText({
      model: myProvider.languageModel(USER_RESEARCH_MODEL_KEY),
      output: Output.object({ schema: egressReviewClassificationSchema }),
      providerOptions: USER_RESEARCH_PROVIDER_OPTIONS,
      experimental_telemetry: { isEnabled: false },
      temperature: 0,
      maxOutputTokens: 2_000,
      maxRetries: 1,
      prompt: prepared.prompt,
    });
    const parsed = egressReviewClassificationSchema.safeParse(result.output);
    if (!parsed.success)
      return manual("classifier_invalid", { ...base, model });
    classification = parsed.data;
  } catch {
    return manual("classifier_unavailable", { ...base, model });
  }

  const decision = decideReview(classification, evidence, prepared);
  if (decision.outcome === "no_case")
    return {
      status: "completed",
      outcome: "no_case",
      reason: decision.reason,
      case: "none",
    };
  const { commands, messages, ...outcome } = decision;
  return persist(outcome, {
    ...base,
    model,
    classification: {
      verdict: classification.verdict,
      activity: classification.activity,
      authorization: classification.authorization,
    },
    locators: {
      commands: commands.map((index) => prepared.commandLocators[index]),
      messages: messages.map((index) => prepared.messageLocators[index]),
    },
  });
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
        ? { outcome: result.outcome, reason: result.reason, case: result.case }
        : result.status === "preserved"
          ? { status: result.status, case: result.case }
          : { status: result.status },
    );
    return result;
  },
});
