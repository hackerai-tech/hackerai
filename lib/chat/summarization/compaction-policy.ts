import { getCompactionSections } from "./structured-summary";
import { randomUUID } from "node:crypto";
import {
  INFERENCE_CYBER_FLAG,
  INFERENCE_CYBER_MODEL_KEY,
  isInferenceConfigured,
  isInferenceCyberModel,
} from "@/lib/ai/inference";
import {
  ABLITERATION_MODEL_KEY,
  ABLITERATION_LARGE_V2_MODEL_KEY,
  isAbliterationConfigured,
} from "@/lib/ai/abliteration";
import {
  getPostHogBooleanFlagDecisionForUser,
  phLogger,
} from "@/lib/posthog/server";
import type { SummarizationUsage } from "@/lib/chat/summarization/helpers";
import type { InvalidCompactionSummaryError } from "./startup-compaction";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";
import { extractOpenRouterMetadataFromError } from "@/lib/api/openrouter-metadata";

export const COMPACTION_POLICY_VERSION = "abliteration_glm53_fallback_v1";
export const MODERATION_COMPACTION_FLAG_KEY =
  "moderation_compaction_recovery_v2";
export const MODERATION_COMPACTION_POLICY_VERSION =
  "moderation_glm53_abliteration_recovery_v2";
export const COMPACTION_FALLBACK_MODEL = "model-glm-5.3-flash";
export const COMPACTION_PRIMARY_MODEL = ABLITERATION_MODEL_KEY;
// Keep per-model policy labels so compaction monitoring cannot mix cohorts.
export const MAX_CONTEXT_COMPACTION_POLICY_VERSION = "max_large_v2_context_v1";
export const PRO_CONTEXT_COMPACTION_POLICY_VERSION = "pro_large_v2_context_v1";
export const INFERENCE_COMPACTION_POLICY_VERSION =
  "inference_abliteration_fallback_v1";
export const INFERENCE_MAX_CONTEXT_COMPACTION_POLICY_VERSION =
  "max_inference_context_v1";
export const INFERENCE_PRO_CONTEXT_COMPACTION_POLICY_VERSION =
  "pro_inference_context_v1";
export const MAX_CONTEXT_SUMMARY_INPUT_TOKENS = 484_000;
type CompactionModel =
  | typeof INFERENCE_CYBER_MODEL_KEY
  | typeof COMPACTION_PRIMARY_MODEL
  | typeof COMPACTION_FALLBACK_MODEL
  | typeof ABLITERATION_LARGE_V2_MODEL_KEY;
export type CompactionSelection = {
  model: CompactionModel;
  fallbackModel?: CompactionModel;
  expandedAgentContext?: boolean;
  policy:
    | typeof INFERENCE_COMPACTION_POLICY_VERSION
    | typeof INFERENCE_MAX_CONTEXT_COMPACTION_POLICY_VERSION
    | typeof INFERENCE_PRO_CONTEXT_COMPACTION_POLICY_VERSION
    | typeof COMPACTION_POLICY_VERSION
    | typeof MODERATION_COMPACTION_POLICY_VERSION
    | typeof MAX_CONTEXT_COMPACTION_POLICY_VERSION
    | typeof PRO_CONTEXT_COMPACTION_POLICY_VERSION;
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
  let code: unknown;
  if (
    typeof record.responseBody === "string" &&
    record.responseBody.length < 32_768
  ) {
    try {
      code = JSON.parse(record.responseBody)?.error?.code;
    } catch {
      /* Not JSON. */
    }
  }
  const knownCodes = [
    "too_many_tool_calls",
    "context_length_exceeded",
    "rate_limit_exceeded",
  ];
  return {
    ...compactionProviderFailure(record.cause, depth + 1),
    ...(typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? { provider_status_code: status }
      : {}),
    ...(typeof code === "string" && knownCodes.includes(code)
      ? { provider_error_code: code }
      : {}),
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
      expandedAgentContext?: boolean;
      onDiscardedUsage: (usage: SummarizationUsage) => void;
    },
  ) {}

  resolve(): Promise<CompactionSelection> {
    return (this.assignment ??= this.evaluate());
  }

  private async evaluate(): Promise<CompactionSelection> {
    const expandedAgentContext =
      this.context.mode === "agent" &&
      this.context.expandedAgentContext === true;
    const configured = isAbliterationConfigured();
    const abliterationModel = expandedAgentContext
      ? ABLITERATION_LARGE_V2_MODEL_KEY
      : COMPACTION_PRIMARY_MODEL;
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
        fallbackModel: configured
          ? abliterationModel
          : COMPACTION_FALLBACK_MODEL,
        policy: expandedAgentContext
          ? this.context.selectedModel === "hackerai-pro"
            ? INFERENCE_PRO_CONTEXT_COMPACTION_POLICY_VERSION
            : INFERENCE_MAX_CONTEXT_COMPACTION_POLICY_VERSION
          : INFERENCE_COMPACTION_POLICY_VERSION,
        flagEnabled: true,
        ...(expandedAgentContext && { expandedAgentContext: true }),
      };
    }
    const flagEnabled = await getPostHogBooleanFlagDecisionForUser(
      MODERATION_COMPACTION_FLAG_KEY,
      this.context.userId,
      { subscription_tier: this.context.subscription },
      { sendFeatureFlagEvents: false },
    );
    const useAbliteration =
      configured && (flagEnabled !== true || this.context.platformAuthorized);
    return {
      model: useAbliteration ? abliterationModel : COMPACTION_FALLBACK_MODEL,
      fallbackModel: useAbliteration
        ? COMPACTION_FALLBACK_MODEL
        : flagEnabled === true && configured
          ? abliterationModel
          : undefined,
      policy: expandedAgentContext
        ? this.context.selectedModel === "hackerai-pro"
          ? PRO_CONTEXT_COMPACTION_POLICY_VERSION
          : MAX_CONTEXT_COMPACTION_POLICY_VERSION
        : flagEnabled === true
          ? MODERATION_COMPACTION_POLICY_VERSION
          : COMPACTION_POLICY_VERSION,
      flagEnabled,
      ...(expandedAgentContext && { expandedAgentContext: true }),
    };
  }

  start(assignment: CompactionSelection, scope: "durable" | "run_scoped") {
    const properties = {
      userId: this.context.userId,
      compaction_policy: assignment.policy,
      compaction_flag_key: isInferenceCyberModel(assignment.model)
        ? INFERENCE_CYBER_FLAG
        : MODERATION_COMPACTION_FLAG_KEY,
      compaction_flag_enabled: assignment.flagEnabled,
      compaction_moderation_selected: this.context.platformAuthorized,
      compaction_moderation_routed:
        assignment.flagEnabled === true &&
        this.context.platformAuthorized &&
        (assignment.model === COMPACTION_PRIMARY_MODEL ||
          assignment.model === ABLITERATION_LARGE_V2_MODEL_KEY),
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
