import { randomUUID } from "node:crypto";
import {
  ABLITERATION_MODEL_KEY,
  isAbliterationConfigured,
} from "@/lib/ai/abliteration";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";
import type { SummarizationUsage } from "@/lib/chat/summarization/helpers";
import type { InvalidCompactionSummaryError } from "./startup-compaction";
import type { ChatMode, SubscriptionTier } from "@/types";
import { extractOpenRouterMetadataFromError } from "@/lib/api/openrouter-metadata";

export const COMPACTION_POLICY_VERSION = "abliteration_glm53_fallback_v1";
export const MODERATION_COMPACTION_FLAG_KEY =
  "moderation_compaction_recovery_v2";
export const MODERATION_COMPACTION_POLICY_VERSION =
  "moderation_glm53_abliteration_recovery_v2";
export const COMPACTION_FALLBACK_MODEL = "model-glm-5.3-flash";
export const COMPACTION_PRIMARY_MODEL = ABLITERATION_MODEL_KEY;
export type CompactionSelection = {
  model: typeof COMPACTION_PRIMARY_MODEL | typeof COMPACTION_FALLBACK_MODEL;
  fallbackModel?:
    typeof COMPACTION_PRIMARY_MODEL | typeof COMPACTION_FALLBACK_MODEL;
  policy:
    | typeof COMPACTION_POLICY_VERSION
    | typeof MODERATION_COMPACTION_POLICY_VERSION;
  flagEnabled: boolean | null;
};

// Missing sections catch plain refusal prose; headings cannot prove fidelity.
export function hasStructuredCompactionSummary(text: string, mode: ChatMode) {
  const sections =
    mode === "agent"
      ? [
          "Target & Scope",
          "Key Findings",
          "User Directives",
          "Progress & Decisions",
          "Current State",
          "Runtime & Execution State",
          "Errors & Recovery",
          "Failed Attempts",
          "Next Steps",
          "Relevant Files & Artifacts",
        ]
      : [
          "Context & Goal",
          "Key Exchanges",
          "Decisions & Conclusions",
          "Current State",
          "User Preferences & Corrections",
          "Relevant Files & Artifacts",
          "Open Threads",
        ];
  return sections.every((section) =>
    text.split("\n").some((line) => line.trim() === `## ${section}`),
  );
}

/** Kept in AgentStreamState so provider retries and repeated compactions share assignment. */
export class CompactionModelPolicy {
  private assignment?: Promise<CompactionSelection>;

  constructor(
    private readonly context: {
      userId: string;
      runId: string;
      chatId: string | null;
      mode: ChatMode;
      subscription: SubscriptionTier;
      baselineModel: string;
      /** Existing shouldUncensorResponse result, never the continuation signal. */
      platformAuthorized: boolean;
      onDiscardedUsage: (usage: SummarizationUsage) => void;
    },
  ) {}

  resolve(): Promise<CompactionSelection> {
    return (this.assignment ??= this.evaluate());
  }

  private async evaluate(): Promise<CompactionSelection> {
    const flagEnabled = await getPostHogBooleanFlagDecisionForUser(
      MODERATION_COMPACTION_FLAG_KEY,
      this.context.userId,
      { subscription_tier: this.context.subscription },
      { sendFeatureFlagEvents: false },
    );
    const configured = isAbliterationConfigured();
    const useAbliteration =
      configured && (flagEnabled !== true || this.context.platformAuthorized);
    return {
      model: useAbliteration
        ? COMPACTION_PRIMARY_MODEL
        : COMPACTION_FALLBACK_MODEL,
      fallbackModel: useAbliteration
        ? COMPACTION_FALLBACK_MODEL
        : flagEnabled === true && configured
          ? COMPACTION_PRIMARY_MODEL
          : undefined,
      policy:
        flagEnabled === true
          ? MODERATION_COMPACTION_POLICY_VERSION
          : COMPACTION_POLICY_VERSION,
      flagEnabled,
    };
  }

  start(assignment: CompactionSelection, scope: "durable" | "run_scoped") {
    const properties = {
      userId: this.context.userId,
      compaction_policy: assignment.policy,
      compaction_flag_key: MODERATION_COMPACTION_FLAG_KEY,
      compaction_flag_enabled: assignment.flagEnabled,
      compaction_moderation_selected: this.context.platformAuthorized,
      compaction_moderation_routed:
        assignment.flagEnabled === true &&
        this.context.platformAuthorized &&
        assignment.model === COMPACTION_PRIMARY_MODEL,
      compaction_run_id: this.context.runId,
      compaction_id: randomUUID(),
      chat_id: this.context.chatId,
      mode: this.context.mode,
      subscription_tier: this.context.subscription,
      baseline_model: this.context.baselineModel,
      assigned_model: assignment.model,
      persistence: scope,
      telemetry_version: 5,
      $process_person_profile: false,
    };
    phLogger.event("compaction_model_started", properties);
    let attempts = 0;
    const startedAt = Date.now();
    return {
      onDiscardedUsage: this.context.onDiscardedUsage,
      attempt: (
        model: string,
        outcome: "completed" | "error" | "aborted",
        durationMs: number,
        usage?: SummarizationUsage,
        failureReason?:
          | InvalidCompactionSummaryError["reason"]
          | "provider_error"
          | "timeout"
          | "canceled",
        error?: unknown,
      ) => {
        attempts++;
        const errorMetadata = extractOpenRouterMetadataFromError(error);
        phLogger.event("compaction_model_attempt_finished", {
          ...properties,
          attempt_index: attempts,
          served_model: model,
          outcome,
          failure_reason: failureReason ?? null,
          duration_ms: durationMs,
          input_tokens: usage?.inputTokens ?? null,
          output_tokens: usage?.outputTokens ?? null,
          cache_read_tokens: usage?.cacheReadTokens ?? null,
          usage_reported: usage?.inputTokensReported === true,
          cost_dollars: usage?.cost ?? null,
          cost_reported: usage?.cost !== undefined,
          upstream_provider:
            usage?.upstreamProvider ??
            errorMetadata.provider_name?.slice(0, 80) ??
            null,
          generation_id:
            usage?.generationId ??
            errorMetadata.openrouter_generation_id?.slice(0, 128) ??
            null,
          finish_reason: usage?.finishReason ?? null,
          reasoning_tokens: usage?.reasoningTokens ?? null,
        });
      },
      finish: (outcome: "completed" | "error" | "aborted", model?: string) =>
        phLogger.event("compaction_model_finished", {
          ...properties,
          outcome,
          served_model: model ?? null,
          attempt_count: attempts,
          fallback_used: attempts > 1,
          primary_success: outcome === "completed" && attempts === 1,
          duration_ms: Date.now() - startedAt,
        }),
    };
  }
}
