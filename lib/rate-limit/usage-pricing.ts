/** Points per dollar (1 point = $0.0001). */
export const POINTS_PER_DOLLAR = 10_000;

/**
 * Request usage pricing multiplier applied to raw provider and tool cost before
 * deducting points from either included allowance or Extra Usage.
 */
export const NORMAL_USAGE_MULTIPLIER = 1.2;

/**
 * Both balances share the request multiplier. Keep the separate analytics name
 * so historical pricing versions remain comparable. Stored Extra Usage points
 * retain their 1.5x dollar conversion without revaluing purchased balances.
 */
export const EXTRA_USAGE_REQUEST_MULTIPLIER = NORMAL_USAGE_MULTIPLIER;

/** Convert included-usage points into the stored points charged to Extra Usage. */
export const includedPointsToExtraUsagePoints = (points: number): number =>
  Number.isFinite(points) && points > 0
    ? Math.ceil(Number(points.toFixed(6)))
    : 0;

/** Express stored Extra Usage points in included-usage coverage units. */
export const extraUsagePointsToIncludedPoints = (points: number): number =>
  Number.isFinite(points) && points > 0 ? points : 0;
