import type { PostHog } from "posthog-node";
import PostHogClient from "@/app/posthog";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";

/** Rollout flag: Enter steers a running Agent instead of queueing. */
export const AGENT_STEERING_FLAG = "agent-mid-run-steering";

/** Lookup is not exposure; the browser records it on a follow-up send. */
export async function isAgentSteeringEnabled(
  userId: string,
  posthog: Pick<PostHog, "getFeatureFlagResult"> | null = PostHogClient(),
): Promise<boolean> {
  if (!userId || !posthog) return false;
  try {
    return (
      (await getPostHogFlagWithoutExposure(
        posthog,
        AGENT_STEERING_FLAG,
        userId,
      )) === true
    );
  } catch {
    // An unavailable flag keeps the existing queue behavior.
    return false;
  }
}
