export const SUBAGENT_TEXT_MODEL = "agent-model-free";
export const SUBAGENT_VISION_MODEL = "model-grok-4.5";

export const resolveSubagentModelForImageToolResults = (
  currentModel: string,
  hasImageToolResults: boolean,
): string => {
  if (currentModel === SUBAGENT_VISION_MODEL) return currentModel;
  return hasImageToolResults ? SUBAGENT_VISION_MODEL : currentModel;
};
