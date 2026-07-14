export const EXTRA_USAGE_MULTIPLIER = 1.15;
export const EXTRA_USAGE_POINTS_PER_DOLLAR = 10_000;

export const extraUsageDollarsToPoints = (dollars: number): number =>
  Number.isFinite(dollars) && dollars > 0
    ? Math.floor(
        (dollars / EXTRA_USAGE_MULTIPLIER) * EXTRA_USAGE_POINTS_PER_DOLLAR,
      )
    : 0;

export const extraUsagePointsToDollars = (points: number): number =>
  Number.isFinite(points) && points > 0
    ? (points / EXTRA_USAGE_POINTS_PER_DOLLAR) * EXTRA_USAGE_MULTIPLIER
    : 0;
