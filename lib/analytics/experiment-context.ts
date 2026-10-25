export type ExperimentAnalyticsContext = {
  key: string;
  variant: string;
  requestId?: string;
  startedAt?: number;
  firstModelChunkAt?: number;
  baselineModel?: string;
  selectedModelOverride?: string;
};

export function getExperimentAnalyticsProperties(
  experiment: ExperimentAnalyticsContext | undefined,
): Record<string, string> {
  if (!experiment) return {};

  return {
    ...(experiment.requestId && {
      experiment_request_id: experiment.requestId,
    }),
    ...(experiment.baselineModel && {
      experiment_baseline_model: experiment.baselineModel,
    }),
    ...(experiment.selectedModelOverride && {
      experiment_selector: experiment.selectedModelOverride,
    }),
    experiment_key: experiment.key,
    experiment_variant: experiment.variant,
    [`$feature/${experiment.key}`]: experiment.variant,
  };
}
