export const ABLITERATION_MAX_GENERATION_STEPS = 3;
export type AbliterationGenerationStepLimit = 1 | 3;

/**
 * Selects the request-scoped route for one zero-based AI SDK generation step.
 * Invalid indexes fail closed to the OpenRouter baseline.
 */
export function resolveAbliterationModelForGenerationStep<T>({
  treatmentModel,
  baselineModel,
  stepIndex,
  generationStepLimit = ABLITERATION_MAX_GENERATION_STEPS,
}: {
  treatmentModel: T;
  baselineModel: T;
  stepIndex: number;
  generationStepLimit?: AbliterationGenerationStepLimit;
}): T {
  return Number.isInteger(stepIndex) &&
    stepIndex >= 0 &&
    (generationStepLimit === 1 || generationStepLimit === 3) &&
    stepIndex < generationStepLimit
    ? treatmentModel
    : baselineModel;
}
