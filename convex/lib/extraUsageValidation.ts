export const validateMonthlyCapDollars = (
  monthlyCapDollars: number | null | undefined,
) => {
  if (
    monthlyCapDollars !== undefined &&
    monthlyCapDollars !== null &&
    (!Number.isFinite(monthlyCapDollars) || monthlyCapDollars < 1)
  ) {
    throw new Error("Monthly spending limit must be at least $1");
  }
};
