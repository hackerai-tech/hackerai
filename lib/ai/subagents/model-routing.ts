export const SUBAGENT_TEXT_MODEL = "agent-model-free";
export const SUBAGENT_VISION_MODEL = "model-grok-4.5";

export const resolveInitialSubagentModel = (input: {
  capabilities: readonly string[];
  complexity: "low" | "medium" | "high";
  expectedDurationMinutes: number;
  outputKind: string;
}): string => {
  const needsRichInspection =
    input.capabilities.includes("browser_qa") ||
    input.outputKind === "qa_report" ||
    input.outputKind === "artifact";
  const needsDeepReasoning =
    input.complexity === "high" && input.expectedDurationMinutes >= 8;
  return needsRichInspection || needsDeepReasoning
    ? SUBAGENT_VISION_MODEL
    : SUBAGENT_TEXT_MODEL;
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
