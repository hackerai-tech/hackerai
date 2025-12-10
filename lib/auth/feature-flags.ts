/**
 * Simple feature flag system for auth features.
 * Uses deterministic hashing of user ID for consistent rollout percentages.
 */

/**
 * Hash a string to a number between 0 and 99.
 * Uses a simple hash algorithm that's consistent across sessions.
 */
function hashToPercentage(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) % 100;
}

/**
 * Check if a feature is enabled for a given user ID based on rollout percentage.
 * @param userId - The user's unique identifier
 * @param featureKey - A unique key for the feature (used in hashing for independent rollouts)
 * @param percentage - Percentage of users who should have the feature enabled (0-100)
 */
export function isFeatureEnabled(
  userId: string,
  featureKey: string,
  percentage: number,
): boolean {
  if (percentage <= 0) return false;
  if (percentage >= 100) return true;

  // Combine userId with featureKey for independent rollouts per feature
  const combinedKey = `${featureKey}:${userId}`;
  const userPercentile = hashToPercentage(combinedKey);

  return userPercentile < percentage;
}

// Feature flag keys
export const FEATURE_FLAGS = {
  CROSS_TAB_TOKEN_SHARING: "cross-tab-token-sharing",
} as const;

// Feature flag rollout percentages (configurable via environment variables)
function getCrossTabRolloutPercentage(): number {
  const envValue = process.env.NEXT_PUBLIC_FF_CROSS_TAB_TOKEN_SHARING;
  if (envValue === undefined || envValue === "") return 0;

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 0 || parsed > 100) return 0;

  return parsed;
}

export const FEATURE_ROLLOUTS = {
  get [FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING]() {
    return getCrossTabRolloutPercentage();
  },
};

/**
 * Check if cross-tab token sharing is enabled for a user.
 */
export function isCrossTabTokenSharingEnabled(userId: string | undefined): boolean {
  if (!userId) return false;

  const enabled = isFeatureEnabled(
    userId,
    FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING,
    FEATURE_ROLLOUTS[FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING],
  );

  console.log(
    `[Feature Flag] ${FEATURE_FLAGS.CROSS_TAB_TOKEN_SHARING}: ${enabled ? "enabled" : "disabled"} for user ${userId.slice(0, 8)}...`,
  );

  return enabled;
}
