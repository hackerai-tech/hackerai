import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";

/**
 * Agent finding retests temporarily reuse the dormant rollout key created for
 * the superseded HTTP replay experiment. Only the key is legacy; the gated
 * behavior is the generic Agent retest history and tools.
 */
export const FINDING_RETESTS_FLAG = "http_finding_retests_v1";
const FLAG_TIMEOUT_MS = 1_000;

/**
 * Fail closed: an unavailable or slow evaluation hides retest history and the
 * Agent retest tools. Assignment reads never emit exposure events.
 */
export async function isFindingRetestsEnabled(
  userId: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (
      (await Promise.race([
        getPostHogBooleanFlagDecisionForUser(
          FINDING_RETESTS_FLAG,
          userId,
          undefined,
          { sendFeatureFlagEvents: false },
        ),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), FLAG_TIMEOUT_MS);
        }),
      ])) === true
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
