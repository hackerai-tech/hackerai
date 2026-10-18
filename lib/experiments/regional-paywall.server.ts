import type { PostHog } from "posthog-node";
import PostHogClient from "@/app/posthog";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import type { RegionalSubscriptionAssignment } from "./regional-subscription-first";
import {
  REGIONAL_PAYWALL_KEY,
  type RegionalPaywallVariant,
} from "./regional-paywall";

/** Resolve presentation only after the existing subscription requirement is established. */
export async function evaluateRegionalPaywall({
  userId,
  assignment,
  posthog = PostHogClient(),
}: {
  userId: string;
  assignment: RegionalSubscriptionAssignment | undefined;
  posthog?: Pick<PostHog, "getFeatureFlagResult"> | null;
}): Promise<RegionalPaywallVariant | null> {
  if (!userId || assignment?.variant !== "test" || !posthog) return null;
  try {
    const variant = await getPostHogFlagWithoutExposure(
      posthog,
      REGIONAL_PAYWALL_KEY,
      userId,
      {
        subscription: "free",
        regional_subscription_country: assignment.country,
      },
    );
    if (variant === "control" || variant === "test") return variant;
  } catch {
    // Missing or unavailable presentation flags retain the old paid offer.
  }
  return null;
}
