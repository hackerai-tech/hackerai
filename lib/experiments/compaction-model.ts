import { randomUUID } from "node:crypto";
import {
  ABLITERATION_MODEL_KEY,
  isAbliterationConfigured,
} from "@/lib/ai/abliteration";
import {
  getPostHogFeatureFlagVariantForUser,
  phLogger,
} from "@/lib/posthog/server";
import type { SummarizationUsage } from "@/lib/chat/summarization/helpers";
import type { ChatMode, SubscriptionTier } from "@/types";

export const COMPACTION_MODEL_FLAG = "compaction-model-abliterated-v1";
export const COMPACTION_CONTROL_MODEL = "model-glm-5.3-flash";
export const COMPACTION_TEST_MODEL = ABLITERATION_MODEL_KEY;
export type CompactionAssignment = {
  variant: "control" | "test";
  model: typeof COMPACTION_CONTROL_MODEL | typeof COMPACTION_TEST_MODEL;
};

// Structural acceptance catches conversational refusals, not semantic loss.
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
export class CompactionModelExperiment {
  private assignment?: Promise<CompactionAssignment | undefined>;
  private exposed = false;

  constructor(
    private readonly context: {
      userId: string;
      runId: string;
      chatId: string | null;
      mode: ChatMode;
      subscription: SubscriptionTier;
      baselineModel: string;
      onDiscardedUsage: (usage: SummarizationUsage) => void;
    },
  ) {}

  resolve(): Promise<CompactionAssignment | undefined> {
    return (this.assignment ??= this.evaluate());
  }

  private async evaluate(): Promise<CompactionAssignment | undefined> {
    if (this.context.subscription === "free" || !isAbliterationConfigured())
      return;
    const variant = await getPostHogFeatureFlagVariantForUser(
      COMPACTION_MODEL_FLAG,
      this.context.userId,
      {
        sendFeatureFlagEvents: false,
        personProperties: {
          subscription: this.context.subscription,
          subscription_tier: this.context.subscription,
        },
      },
    );
    if (variant !== "control" && variant !== "test") return;
    return {
      variant,
      model:
        variant === "test" ? COMPACTION_TEST_MODEL : COMPACTION_CONTROL_MODEL,
    };
  }

  start(assignment: CompactionAssignment, scope: "durable" | "run_scoped") {
    const properties = {
      userId: this.context.userId,
      experiment_key: COMPACTION_MODEL_FLAG,
      experiment_variant: assignment.variant,
      [`$feature/${COMPACTION_MODEL_FLAG}`]: assignment.variant,
      compaction_run_id: this.context.runId,
      compaction_id: randomUUID(),
      chat_id: this.context.chatId,
      mode: this.context.mode,
      subscription_tier: this.context.subscription,
      baseline_model: this.context.baselineModel,
      assigned_model: assignment.model,
      persistence: scope,
      telemetry_version: 1,
      $process_person_profile: false,
    };
    if (!this.exposed) {
      this.exposed = true;
      phLogger.event("$feature_flag_called", {
        ...properties,
        $feature_flag: COMPACTION_MODEL_FLAG,
        $feature_flag_response: assignment.variant,
      });
    }
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
      ) => {
        attempts++;
        phLogger.event("compaction_model_attempt_finished", {
          ...properties,
          attempt_index: attempts,
          served_model: model,
          outcome,
          duration_ms: durationMs,
          input_tokens: usage?.inputTokens ?? null,
          output_tokens: usage?.outputTokens ?? null,
          usage_reported: usage?.inputTokensReported === true,
          cost_dollars: usage?.cost ?? null,
          cost_reported: usage?.cost !== undefined,
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
