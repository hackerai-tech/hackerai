export type ExperimentAnalyticsContext = {
  key: string;
  variant: string;
  requestId?: string;
};

export function getExperimentAnalyticsProperties(
  experiment: ExperimentAnalyticsContext | undefined,
): Record<string, string> {
  if (!experiment) return {};

  return {
    ...(experiment.requestId && {
      experiment_request_id: experiment.requestId,
    }),
    experiment_key: experiment.key,
    experiment_variant: experiment.variant,
    [`$feature/${experiment.key}`]: experiment.variant,
  };
}
