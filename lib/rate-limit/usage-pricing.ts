/** Points per dollar (1 point = $0.0001). */
export const POINTS_PER_DOLLAR = 10_000;

/**
 * Request usage pricing multiplier applied to raw provider and tool cost before
 * deducting points from a paid plan's included balance.
 */
export const NORMAL_USAGE_MULTIPLIER = 1.5;

/**
 * Request multiplier used when provider/tool cost is paid from Extra Usage.
 * Stored Extra Usage points retain their existing 1.5x dollar conversion; this
 * separate consumption multiplier lets included and prepaid usage be priced
 * independently without revaluing balances customers already purchased.
 */
export const EXTRA_USAGE_REQUEST_MULTIPLIER = 1.4;

/** Convert included-usage points into the stored points charged to Extra Usage. */
export const includedPointsToExtraUsagePoints = (points: number): number =>
  Number.isFinite(points) && points > 0
    ? Math.ceil(
        Number(
          (
            (points * EXTRA_USAGE_REQUEST_MULTIPLIER) /
            NORMAL_USAGE_MULTIPLIER
          ).toFixed(6),
        ),
      )
    : 0;

/** Express stored Extra Usage points in included-usage coverage units. */
export const extraUsagePointsToIncludedPoints = (points: number): number =>
  Number.isFinite(points) && points > 0
    ? (points * NORMAL_USAGE_MULTIPLIER) / EXTRA_USAGE_REQUEST_MULTIPLIER
    : 0;
