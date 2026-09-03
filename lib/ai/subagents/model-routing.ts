import type { SubscriptionTier } from "@/types";

export const SUBAGENT_FREE_TEXT_MODEL = "agent-model-free";
export const SUBAGENT_PAID_TEXT_MODEL = "model-deepseek-v4-flash-0731";
export const SUBAGENT_VISION_MODEL = "model-deepseek-v4-flash-vision";

export const resolveSubagentTextModel = (
  subscription: SubscriptionTier,
): string =>
  subscription === "free" ? SUBAGENT_FREE_TEXT_MODEL : SUBAGENT_PAID_TEXT_MODEL;

export const resolveInitialSubagentModel = (input: {
  capabilities: readonly string[];
  complexity: "low" | "medium" | "high";
  expectedDurationMinutes: number;
  outputKind: string;
  subscription: SubscriptionTier;
}): string => {
  const needsRichInspection =
    input.capabilities.includes("browser_qa") ||
    input.outputKind === "qa_report" ||
    input.outputKind === "artifact";
  const needsDeepReasoning =
    input.complexity === "high" && input.expectedDurationMinutes >= 8;
  return needsRichInspection || needsDeepReasoning
    ? SUBAGENT_VISION_MODEL
    : resolveSubagentTextModel(input.subscription);
};

export const resolveSubagentTriggerPriority = (input: {
  capabilities: readonly string[];
  complexity: "low" | "medium" | "high";
  expectedDurationMinutes: number;
  outputKind: string;
}): number => {
  if (
    input.capabilities.includes("browser_qa") ||
    input.outputKind === "qa_report"
  ) {
    return 10;
  }
  if (input.complexity === "high" || input.expectedDurationMinutes >= 10) {
    return 5;
  }
  return 0;
};

export const resolveSubagentModelForImageToolResults = (
  currentModel: string,
  hasImageToolResults: boolean,
): string => {
  if (currentModel === SUBAGENT_VISION_MODEL) return currentModel;
  return hasImageToolResults ? SUBAGENT_VISION_MODEL : currentModel;
};
