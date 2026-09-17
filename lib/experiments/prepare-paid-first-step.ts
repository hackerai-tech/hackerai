import PostHogClient from "@/app/posthog";
import type { SubscriptionTier } from "@/types";
import { PAID_FIRST_STEP_ABLITERATED_EXPERIMENT_KEY } from "./abliteration-keys";
import { getPaidFirstStepEnrollment } from "./paid-first-step-enrollment";

/** Freeze billing in the authenticated web runtime; Trigger has no billing credentials. */
export async function preparePaidFirstStepEnrollment(args: {
  userId: string;
  organizationId?: string;
  subscription: SubscriptionTier;
  isAutomaticContinuation?: boolean;
  limitRescue?: boolean;
}) {
  if (
    !args.organizationId ||
    args.isAutomaticContinuation ||
    args.limitRescue ||
    (args.subscription !== "pro" &&
      args.subscription !== "pro-plus" &&
      args.subscription !== "ultra")
  )
    return;
  const posthog = PostHogClient();
  if (!posthog) return;
  try {
    const variant = await posthog.getFeatureFlag(
      PAID_FIRST_STEP_ABLITERATED_EXPERIMENT_KEY,
      args.userId,
      {
        sendFeatureFlagEvents: false,
        personProperties: {
          subscription: args.subscription,
          subscription_tier: args.subscription,
        },
      },
    );
    if (variant !== "test" && variant !== "control") return;
    await getPaidFirstStepEnrollment({
      userId: args.userId,
      organizationId: args.organizationId,
      subscription: args.subscription,
      variant,
    });
  } catch {
    // Enrollment is optional. The worker retains current routing without a record.
  } finally {
    await posthog.shutdown().catch(() => {});
  }
}
