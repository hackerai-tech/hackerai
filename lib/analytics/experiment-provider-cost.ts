import { isAbliterationModel } from "@/lib/ai/abliteration";
import { calculateRawModelUsageCostDollars } from "@/lib/rate-limit/token-bucket";

/** Experiment estimate only: does not change customer allowance accounting. */
export function estimateExperimentProviderCost(args: {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}) {
  if (!isAbliterationModel(args.modelName))
    return calculateRawModelUsageCostDollars(args);
  // https://docs.abliteration.ai/pricing, verified 2026-09-16.
  const large = args.modelName.includes("large-v2");
  const inputRate = large ? 3 : 1;
  const outputRate = large ? 5 : 3;
  const cached = Math.min(
    args.inputTokens,
    Math.max(0, args.cacheReadTokens ?? 0),
  );
  return (
    ((args.inputTokens - cached) * inputRate +
      cached * inputRate * 0.1 +
      args.outputTokens * outputRate) /
    1_000_000
  );
}
