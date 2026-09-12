import { randomUUID } from "node:crypto";
import {
  getPostHogFeatureFlagVariantForUser,
  phLogger,
} from "@/lib/posthog/server";
import type { ChatMode } from "@/types";
import type { SummarizationUsage } from "./helpers";

export const SUMMARIZATION_MODEL_FLAG = "summarization-deepseek-v41-v1";
export const SUMMARIZATION_MODEL_EXPOSURE =
  "summarization_model_experiment_exposed";
export const SUMMARIZATION_MODEL_OUTCOME =
  "summarization_model_experiment_finished";
export const DEEPSEEK_SUMMARIZATION_MODEL = "summarization-deepseek-v41";

export async function getSummarizationModelAssignment(userId?: string) {
  if (!userId) return undefined;
  try {
    const variant = await getPostHogFeatureFlagVariantForUser(
      SUMMARIZATION_MODEL_FLAG,
      userId,
      { sendFeatureFlagEvents: false },
    );
    if (variant !== "control" && variant !== "test") return undefined;
    return {
      variant,
      modelKey:
        variant === "test"
          ? DEEPSEEK_SUMMARIZATION_MODEL
          : "model-glm-5.3-flash",
    };
  } catch {
    return undefined;
  }
}

/** Called only at actual generation, with bounded metadata and no conversation content. */
export function startSummarizationModelMeasurement({
  userId,
  chatId,
  assignment,
  mode,
  scope,
  startupPolicy,
}: {
  userId?: string;
  chatId?: string | null;
  assignment: Awaited<ReturnType<typeof getSummarizationModelAssignment>>;
  mode: ChatMode;
  scope: "durable" | "in_run";
  startupPolicy: string;
}) {
  if (!userId || !assignment) return undefined;
  const startedAt = Date.now();
  const properties = {
    userId,
    chat_id: chatId ?? undefined,
    compaction_attempt_id: randomUUID(),
    experiment_key: SUMMARIZATION_MODEL_FLAG,
    experiment_variant: assignment.variant,
    [`$feature/${SUMMARIZATION_MODEL_FLAG}`]: assignment.variant,
    configured_model:
      assignment.variant === "test"
        ? "deepseek/deepseek-v4.1-flash"
        : "z-ai/glm-5.3-flash",
    mode,
    scope,
    startup_policy: startupPolicy,
  };
  phLogger.event(SUMMARIZATION_MODEL_EXPOSURE, properties);
  // Explicit exposure at generation, not during the feature-flag lookup.
  phLogger.event("$feature_flag_called", {
    userId,
    $feature_flag: SUMMARIZATION_MODEL_FLAG,
    $feature_flag_response: assignment.variant,
    [`$feature/${SUMMARIZATION_MODEL_FLAG}`]: assignment.variant,
  });
  return (
    outcome: "success" | "error" | "aborted",
    fallbackUsed: boolean,
    usage?: SummarizationUsage,
  ) => {
    phLogger.event(SUMMARIZATION_MODEL_OUTCOME, {
      ...properties,
      outcome,
      duration_ms: Date.now() - startedAt,
      fallback_used: fallbackUsed,
      ...(usage && {
        served_model: usage.model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        // Failed/aborted earlier attempts may have unreported cost; this is final-call cost only.
        ...(usage.cost !== undefined && { final_call_cost_usd: usage.cost }),
      }),
    });
  };
}
