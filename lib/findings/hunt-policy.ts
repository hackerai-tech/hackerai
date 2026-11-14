import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";

export const FINDING_HUNTS_FLAG = "finding_variant_hunts_v1";
const FLAG_TIMEOUT_MS = 1_000;

/**
 * Fail closed: an unavailable or slow evaluation hides hunt history and new
 * hunts. Assignment reads never emit exposure events; exposure is captured
 * only when the hunt controls are actually shown.
 */
export async function isFindingHuntsEnabled(userId: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (
      (await Promise.race([
        getPostHogBooleanFlagDecisionForUser(
          FINDING_HUNTS_FLAG,
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
