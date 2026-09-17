export type ExperimentAnalyticsContext = {
  key: string;
  variant: string;
  requestId?: string;
  paidFirstStep?: {
    enrollmentId: string;
    enrolledAt: number;
    baselineRenewalAt: number;
    stripeSubscriptionId: string;
    stripeCustomerId: string;
    organizationId: string;
    billingInterval: string;
    billingIntervalCount: number;
    subscriptionStartedAt: number;
    cancelAtPeriodEnd: boolean;
    subscriptionTier: string;
    currentRoutingModel: string;
    routingChanged: boolean;
  };
};

export function getExperimentAnalyticsProperties(
  experiment: ExperimentAnalyticsContext | undefined,
): Record<string, string | number | boolean> {
  if (!experiment) return {};

  return {
    ...(experiment.requestId && {
      experiment_request_id: experiment.requestId,
    }),
    experiment_key: experiment.key,
    experiment_variant: experiment.variant,
    [`$feature/${experiment.key}`]: experiment.variant,
    ...(experiment.paidFirstStep && {
      paid_first_step_enrollment_id: experiment.paidFirstStep.enrollmentId,
      paid_first_step_enrolled_at: experiment.paidFirstStep.enrolledAt,
      baseline_renewal_at: experiment.paidFirstStep.baselineRenewalAt,
      baseline_stripe_subscription_id:
        experiment.paidFirstStep.stripeSubscriptionId,
      baseline_stripe_customer_id: experiment.paidFirstStep.stripeCustomerId,
      baseline_organization_id: experiment.paidFirstStep.organizationId,
      baseline_billing_interval: experiment.paidFirstStep.billingInterval,
      baseline_billing_interval_count:
        experiment.paidFirstStep.billingIntervalCount,
      baseline_subscription_started_at:
        experiment.paidFirstStep.subscriptionStartedAt,
      baseline_cancel_at_period_end: experiment.paidFirstStep.cancelAtPeriodEnd,
      baseline_subscription_tier: experiment.paidFirstStep.subscriptionTier,
      current_routing_model: experiment.paidFirstStep.currentRoutingModel,
      paid_first_step_routing_changed: experiment.paidFirstStep.routingChanged,
    }),
  };
}
