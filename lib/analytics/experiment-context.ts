export type ExperimentAnalyticsContext = {
  key: string;
  variant: string;
};

export function getExperimentAnalyticsProperties(
  experiment: ExperimentAnalyticsContext | undefined,
): Record<string, string> {
  if (!experiment) return {};

  return {
    experiment_key: experiment.key,
    experiment_variant: experiment.variant,
    [`$feature/${experiment.key}`]: experiment.variant,
  };
}
