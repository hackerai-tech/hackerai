export const ABLITERATION_MAX_GENERATION_STEPS = 1;

/**
 * Selects the request-scoped route for one zero-based AI SDK generation step.
 * Invalid indexes fail closed to the OpenRouter baseline.
 */
export function resolveAbliterationModelForGenerationStep<T>({
  treatmentModel,
  baselineModel,
  stepIndex,
}: {
  treatmentModel: T;
  baselineModel: T;
  stepIndex: number;
}): T {
  return Number.isInteger(stepIndex) &&
    stepIndex >= 0 &&
    stepIndex < ABLITERATION_MAX_GENERATION_STEPS
    ? treatmentModel
    : baselineModel;
}
