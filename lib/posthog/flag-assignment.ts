import type { PostHog } from "posthog-node";

/** Evaluate assignment without counting it as exposure to the experience. */
export async function getPostHogFlagWithoutExposure(
  client: Pick<PostHog, "getFeatureFlagResult">,
  flagKey: string,
  userId: string,
  personProperties?: Record<string, string>,
): Promise<boolean | string | undefined> {
  // posthog-node 5.54.1's evaluateFlags().getFlag() always records access and
  // does not accept sendFeatureFlagEvents. Keep deferred exposure on the
  // supported result API until the snapshot API can preserve that contract.
  const result = await client.getFeatureFlagResult(flagKey, userId, {
    sendFeatureFlagEvents: false,
    ...(personProperties && { personProperties }),
  });
  if (!result) return undefined;
  return result.enabled === false ? false : (result.variant ?? true);
}
