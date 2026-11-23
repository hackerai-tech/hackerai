import { getCompactionSections } from "./structured-summary";
import { randomUUID } from "node:crypto";
import {
  INFERENCE_CYBER_FLAG,
  INFERENCE_CYBER_MODEL_KEY,
  isInferenceConfigured,
  isInferenceCyberModel,
} from "@/lib/ai/inference";
import { DEEPSEEK_1017_MODEL_KEY } from "@/lib/experiments/paid-deepseek-1017";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";
import type { SummarizationUsage } from "@/lib/chat/summarization/helpers";
import { InvalidCompactionSummaryError } from "./startup-compaction";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";
import { extractOpenRouterMetadataFromError } from "@/lib/api/openrouter-metadata";
import type { AgentContextPolicy } from "@/lib/ai/agent-context-budget";
import { getSafeProviderErrorCode } from "@/lib/ai/inference-request-recovery";

export const COMPACTION_POLICY_VERSION = "abliteration_glm53_fallback_v1";
export const COMPACTION_FALLBACK_MODEL = "model-glm-5.3-flash";
/** Inference summaries recover on DeepSeek V4.1 Flash before GLM. */
export const INFERENCE_COMPACTION_FALLBACK_MODEL = DEEPSEEK_1017_MODEL_KEY;
// Keep per-model policy labels so compaction monitoring cannot mix cohorts.
export const MAX_CONTEXT_COMPACTION_POLICY_VERSION = "max_large_v2_context_v1";
export const PRO_CONTEXT_COMPACTION_POLICY_VERSION = "pro_large_v2_context_v1";
export const INFERENCE_COMPACTION_POLICY_VERSION =
  "inference_abliteration_fallback_v1";
export const INFERENCE_MAX_CONTEXT_COMPACTION_POLICY_VERSION =
  "max_inference_context_v1";
export const INFERENCE_PRO_CONTEXT_COMPACTION_POLICY_VERSION =
  "pro_inference_context_v1";
// Paid Auto/Standard 480K context shares the expanded summary input policy,
// under its own labels so its compactions never mix with Pro/Max. Saved data
// references these identifiers; keep them stable.
export const PAID_480K_CONTEXT_COMPACTION_POLICY_VERSION =
  "paid_480k_large_v2_context_v1";
export const INFERENCE_PAID_480K_CONTEXT_COMPACTION_POLICY_VERSION =
  "paid_480k_inference_context_v1";
export const MAX_CONTEXT_SUMMARY_INPUT_TOKENS = 484_000;
type CompactionModel =
  | typeof INFERENCE_CYBER_MODEL_KEY
  | typeof COMPACTION_FALLBACK_MODEL
  | typeof INFERENCE_COMPACTION_FALLBACK_MODEL;
export type CompactionSelection = {
  model: CompactionModel;
  fallbackModel?: CompactionModel;
  expandedAgentContext?: boolean;
  policy:
    | typeof INFERENCE_COMPACTION_POLICY_VERSION
    | typeof INFERENCE_MAX_CONTEXT_COMPACTION_POLICY_VERSION
    | typeof INFERENCE_PRO_CONTEXT_COMPACTION_POLICY_VERSION
    | typeof COMPACTION_POLICY_VERSION
    | typeof MAX_CONTEXT_COMPACTION_POLICY_VERSION
    | typeof PRO_CONTEXT_COMPACTION_POLICY_VERSION
    | typeof PAID_480K_CONTEXT_COMPACTION_POLICY_VERSION
    | typeof INFERENCE_PAID_480K_CONTEXT_COMPACTION_POLICY_VERSION;
  flagEnabled: boolean | null;
};

/** Capture provider classifications without storing response bodies or user content. */
function compactionProviderFailure(
  error: unknown,
  depth = 0,
): {
  provider_status_code?: number;
  provider_error_code?: string;
} {
  if (depth > 4 || typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  const status = record.statusCode;
  // Shared exact allowlist, including Inference's capacity_exceeded.
  const code = getSafeProviderErrorCode(record);
  return {
    ...compactionProviderFailure(record.cause, depth + 1),
    ...(typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? { provider_status_code: status }
      : {}),
    ...(code ? { provider_error_code: code } : {}),
  };
}

// Missing sections catch plain refusal prose; headings cannot prove fidelity.
export function hasStructuredCompactionSummary(text: string, mode: ChatMode) {
  const sections = getCompactionSections(mode);
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
      selectedModel?: SelectedModel;
      /** Existing shouldUncensorResponse result, never the continuation signal. */
      platformAuthorized: boolean;
      /** Shorthand for the `expanded` policy, retained for subagent callers. */
      expandedAgentContext?: boolean;
      /** The top-level run's resolved policy; takes precedence over the shorthand. */
      agentContextPolicy?: AgentContextPolicy;
      onDiscardedUsage: (usage: SummarizationUsage) => void;
    },
  ) {}

  resolve(): Promise<CompactionSelection> {
    return (this.assignment ??= this.evaluate());
  }

  private async evaluate(): Promise<CompactionSelection> {
    const policy =
      this.context.mode !== "agent"
        ? "baseline"
        : (this.context.agentContextPolicy ??
          (this.context.expandedAgentContext ? "expanded" : "baseline"));
    const paidContext = policy === "paid_480k";
    const expandedAgentContext = policy !== "baseline";
    // Share the deployed generation rollout's rollback control. Compaction
    // applies to every plan and does not change chat-generation eligibility.
    if (
      isInferenceConfigured() &&
      (await getPostHogBooleanFlagDecisionForUser(
        INFERENCE_CYBER_FLAG,
        this.context.userId,
        {
          subscription: this.context.subscription,
          subscription_tier: this.context.subscription,
        },
        { sendFeatureFlagEvents: false },
      )) === true
    ) {
      return {
        model: INFERENCE_CYBER_MODEL_KEY,
        fallbackModel: INFERENCE_COMPACTION_FALLBACK_MODEL,
        policy: paidContext
          ? INFERENCE_PAID_480K_CONTEXT_COMPACTION_POLICY_VERSION
          : expandedAgentContext
            ? this.context.selectedModel === "hackerai-pro"
              ? INFERENCE_PRO_CONTEXT_COMPACTION_POLICY_VERSION
              : INFERENCE_MAX_CONTEXT_COMPACTION_POLICY_VERSION
            : INFERENCE_COMPACTION_POLICY_VERSION,
        flagEnabled: true,
        ...(expandedAgentContext && { expandedAgentContext: true }),
      };
    }
    return {
      model: COMPACTION_FALLBACK_MODEL,
      policy: paidContext
        ? PAID_480K_CONTEXT_COMPACTION_POLICY_VERSION
        : expandedAgentContext
          ? this.context.selectedModel === "hackerai-pro"
            ? PRO_CONTEXT_COMPACTION_POLICY_VERSION
            : MAX_CONTEXT_COMPACTION_POLICY_VERSION
          : COMPACTION_POLICY_VERSION,
      flagEnabled: false,
      ...(expandedAgentContext && { expandedAgentContext: true }),
    };
  }

  start(assignment: CompactionSelection, scope: "durable" | "run_scoped") {
    const properties = {
      userId: this.context.userId,
      compaction_policy: assignment.policy,
      compaction_flag_key: isInferenceCyberModel(assignment.model)
        ? INFERENCE_CYBER_FLAG
        : null,
      compaction_flag_enabled: assignment.flagEnabled,
      compaction_moderation_selected: this.context.platformAuthorized,
      compaction_run_id: this.context.runId,
      compaction_id: randomUUID(),
      chat_id: this.context.chatId,
      mode: this.context.mode,
      subscription_tier: this.context.subscription,
      baseline_model: this.context.baselineModel,
      assigned_model: assignment.model,
      persistence: scope,
      telemetry_version: 8,
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
          ...(failureReason === "missing_sections" &&
            error instanceof InvalidCompactionSummaryError &&
            error.structuredFailureKind && {
              structured_summary_diagnostic_version: 1,
              structured_summary_failure_kind: error.structuredFailureKind,
            }),
          ...compactionProviderFailure(error),
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
