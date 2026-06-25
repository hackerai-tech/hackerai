import type { ChatMode, SubscriptionTier } from "@/types";
import type { ModelName } from "@/lib/ai/providers";
import type { PostHog } from "posthog-node";

export const FREE_ASK_REASONING_EXPERIMENT_KEY =
  "free_ask_deepseek_reasoning_v1";
export const FREE_ASK_REASONING_CONTROL_VARIANT = "control";
export const FREE_ASK_REASONING_TREATMENT_VARIANT = "reasoning_medium";
export const FREE_ASK_REASONING_EVENT_VERSION = 1;

export type FreeAskReasoningVariant =
  | typeof FREE_ASK_REASONING_CONTROL_VARIANT
  | typeof FREE_ASK_REASONING_TREATMENT_VARIANT;

export type FreeAskReasoningExperimentAssignment = {
  experimentKey: typeof FREE_ASK_REASONING_EXPERIMENT_KEY;
  featureFlagKey: typeof FREE_ASK_REASONING_EXPERIMENT_KEY;
  eventVersion: typeof FREE_ASK_REASONING_EVENT_VERSION;
  variant: FreeAskReasoningVariant;
  source: "posthog" | "env";
  reasoning: {
    enabled: boolean;
    effort?: "medium";
  };
  treatmentPercentage?: number;
};

type PostHogFeatureFlagClient = {
  getFeatureFlag?: (
    key: string,
    distinctId: string,
    options?: {
      personProperties?: Record<string, unknown>;
      groups?: Record<string, string>;
      onlyEvaluateLocally?: boolean;
    },
  ) => Promise<unknown> | unknown;
  capture?: PostHog["capture"];
};

type ResolveFreeAskReasoningExperimentArgs = {
  posthog: PostHog | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModel: ModelName;
  fileCount: number;
};

type CaptureBaseArgs = {
  posthog: PostHog | null;
  userId: string;
  chatId: string;
  subscription: string;
  mode: ChatMode;
  selectedModel: string;
  assignment: FreeAskReasoningExperimentAssignment | null;
};

const readTreatmentPercentage = (): number => {
  const raw = process.env.FREE_ASK_REASONING_EXPERIMENT_TREATMENT_PERCENTAGE;
  if (raw === undefined || raw.trim() === "") return 0;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return 0;
  return parsed;
};

const hashToPercentage = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 100;
};

const normalizeVariant = (value: unknown): FreeAskReasoningVariant | null => {
  if (value === FREE_ASK_REASONING_CONTROL_VARIANT) {
    return FREE_ASK_REASONING_CONTROL_VARIANT;
  }
  if (value === FREE_ASK_REASONING_TREATMENT_VARIANT) {
    return FREE_ASK_REASONING_TREATMENT_VARIANT;
  }
  return null;
};

const assignmentForVariant = (
  variant: FreeAskReasoningVariant,
  source: FreeAskReasoningExperimentAssignment["source"],
  treatmentPercentage?: number,
): FreeAskReasoningExperimentAssignment => {
  const treatment = variant === FREE_ASK_REASONING_TREATMENT_VARIANT;
  return {
    experimentKey: FREE_ASK_REASONING_EXPERIMENT_KEY,
    featureFlagKey: FREE_ASK_REASONING_EXPERIMENT_KEY,
    eventVersion: FREE_ASK_REASONING_EVENT_VERSION,
    variant,
    source,
    reasoning: treatment
      ? { enabled: true, effort: "medium" }
      : { enabled: false },
    ...(treatmentPercentage !== undefined && { treatmentPercentage }),
  };
};

const getPostHogVariant = async ({
  posthog,
  userId,
  subscription,
  mode,
  selectedModel,
}: Omit<
  ResolveFreeAskReasoningExperimentArgs,
  "fileCount"
>): Promise<FreeAskReasoningVariant | null> => {
  const client = posthog as PostHogFeatureFlagClient | null;
  if (!client?.getFeatureFlag) return null;

  try {
    const variant = await client.getFeatureFlag(
      FREE_ASK_REASONING_EXPERIMENT_KEY,
      userId,
      {
        personProperties: {
          subscription_tier: subscription,
          subscription,
          mode,
          selected_model: selectedModel,
        },
      },
    );
    return normalizeVariant(variant);
  } catch {
    return null;
  }
};

const getEnvVariant = (
  userId: string,
): FreeAskReasoningExperimentAssignment | null => {
  const treatmentPercentage = readTreatmentPercentage();
  if (treatmentPercentage <= 0) return null;

  const bucket = hashToPercentage(
    `${FREE_ASK_REASONING_EXPERIMENT_KEY}:${userId}`,
  );
  const variant =
    bucket < treatmentPercentage
      ? FREE_ASK_REASONING_TREATMENT_VARIANT
      : FREE_ASK_REASONING_CONTROL_VARIANT;

  return assignmentForVariant(variant, "env", treatmentPercentage);
};

export async function resolveFreeAskReasoningExperiment({
  posthog,
  userId,
  subscription,
  mode,
  selectedModel,
  fileCount,
}: ResolveFreeAskReasoningExperimentArgs): Promise<FreeAskReasoningExperimentAssignment | null> {
  if (
    subscription !== "free" ||
    mode !== "ask" ||
    selectedModel !== "ask-model-free" ||
    fileCount > 0
  ) {
    return null;
  }

  const posthogVariant = await getPostHogVariant({
    posthog,
    userId,
    subscription,
    mode,
    selectedModel,
  });
  if (posthogVariant) {
    return assignmentForVariant(posthogVariant, "posthog");
  }

  return getEnvVariant(userId);
}

export function getFreeAskReasoningExperimentProperties(
  assignment: FreeAskReasoningExperimentAssignment | null,
) {
  if (!assignment) return {};

  return {
    experiment_key: assignment.experimentKey,
    feature_flag_key: assignment.featureFlagKey,
    variant: assignment.variant,
    experiment_variant: assignment.variant,
    experiment_source: assignment.source,
    experiment_event_version: assignment.eventVersion,
    reasoning_enabled: assignment.reasoning.enabled,
    ...(assignment.reasoning.effort && {
      reasoning_effort: assignment.reasoning.effort,
    }),
    ...(assignment.treatmentPercentage !== undefined && {
      treatment_percentage: assignment.treatmentPercentage,
    }),
    [`$feature/${assignment.featureFlagKey}`]: assignment.variant,
  };
}

export function captureFreeAskReasoningExperimentExposure({
  posthog,
  userId,
  chatId,
  subscription,
  mode,
  selectedModel,
  assignment,
  estimatedInputTokens,
  isNewChat,
}: CaptureBaseArgs & {
  estimatedInputTokens: number;
  isNewChat: boolean;
}) {
  if (!posthog || !assignment) return;

  const now = new Date().toISOString();
  posthog.capture({
    distinctId: userId,
    event: "free_ask_reasoning_experiment_exposed",
    properties: {
      user_id: userId,
      chat_id: chatId,
      subscription,
      subscription_tier: subscription,
      mode,
      selected_model: selectedModel,
      estimated_input_tokens: estimatedInputTokens,
      is_new_chat: isNewChat,
      ...getFreeAskReasoningExperimentProperties(assignment),
      $set_once: {
        free_ask_reasoning_first_exposed_at: now,
        free_ask_reasoning_first_variant: assignment.variant,
      },
    },
  });
}

export function captureFreeAskReasoningExperimentResult({
  posthog,
  userId,
  chatId,
  subscription,
  mode,
  selectedModel,
  assignment,
  outcome,
  generationTimeMs,
  finishReason,
}: CaptureBaseArgs & {
  outcome: "success" | "aborted" | "error";
  generationTimeMs?: number;
  finishReason?: string;
}) {
  if (!posthog || !assignment) return;

  posthog.capture({
    distinctId: userId,
    event: "free_ask_reasoning_experiment_result",
    properties: {
      user_id: userId,
      chat_id: chatId,
      subscription,
      subscription_tier: subscription,
      mode,
      selected_model: selectedModel,
      outcome,
      ...(generationTimeMs !== undefined && {
        generation_time_ms: generationTimeMs,
      }),
      ...(finishReason && { finish_reason: finishReason }),
      ...getFreeAskReasoningExperimentProperties(assignment),
    },
  });
}
