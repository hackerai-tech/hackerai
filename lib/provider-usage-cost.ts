export const isPositiveFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getOpenRouterUpstreamInferenceCostFromUsageRaw = (
  raw: unknown,
): number | undefined => {
  if (!isRecord(raw)) return undefined;

  for (const costDetails of [raw.cost_details, raw.costDetails]) {
    if (!isRecord(costDetails)) continue;

    const upstreamInferenceCost =
      costDetails.upstream_inference_cost ?? costDetails.upstreamInferenceCost;
    if (isPositiveFiniteNumber(upstreamInferenceCost)) {
      return upstreamInferenceCost;
    }
  }

  return undefined;
};

export const getProviderUsageRawModelCost = (
  raw: unknown,
  isByok?: boolean,
): number | undefined => {
  if (!isRecord(raw)) return undefined;

  const upstreamInferenceCost =
    getOpenRouterUpstreamInferenceCostFromUsageRaw(raw);
  const chargedCost = isPositiveFiniteNumber(raw.cost) ? raw.cost : undefined;
  const reportedIsByok =
    isByok ?? (typeof raw.is_byok === "boolean" ? raw.is_byok : undefined);

  // BYOK inference is charged by the upstream provider even when OpenRouter
  // reports zero credit spend. Other routes use OpenRouter's charged cost.
  return reportedIsByok === true
    ? (upstreamInferenceCost ?? chargedCost)
    : (chargedCost ?? upstreamInferenceCost);
};
