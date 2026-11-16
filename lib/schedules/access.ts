import { getPostHogFeatureFlagForUser } from "@/lib/posthog/server";
import type { SubscriptionTier } from "@/types";

import { SCHEDULES_FLAG } from "./recurrence";
export async function canUseSchedules(
  userId: string,
  subscription: SubscriptionTier,
) {
  if (subscription === "free") return false;
  return getPostHogFeatureFlagForUser(SCHEDULES_FLAG, userId);
}
