import type {
  ChatMode,
  ExtraUsageConfig,
  SelectedModel,
  SubscriptionTier,
} from "@/types";

export const AGENT_RUN_SPEND_CAP_REASON = "agent_run_spend_cap" as const;
export const AGENT_RUN_SPEND_CAP_FINISH_REASON = "agent-run-spend-cap" as const;
export const PRO_AGENT_RUN_SPEND_CAP_DOLLARS = 5;
export const AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL =
  "hackerai-standard" as const satisfies SelectedModel;

export const AGENT_RUN_SPEND_CAP_BASES = ["fixed_5_dollars"] as const;

export type AgentRunSpendCapBasis = (typeof AGENT_RUN_SPEND_CAP_BASES)[number];

export interface AgentRunSpendCap {
  capDollars: number;
  basis: AgentRunSpendCapBasis;
}

export interface AgentRunSpendCapHit {
  runCostDollars: number;
  runCapDollars: number;
  monthlyRemainingDollars: number;
  capBasis: AgentRunSpendCapBasis;
  premiumContinuationAllowed: boolean;
}

export function isAgentRunSpendCapBasis(
  value: unknown,
): value is AgentRunSpendCapBasis {
  return (
    typeof value === "string" &&
    (AGENT_RUN_SPEND_CAP_BASES as readonly string[]).includes(value)
  );
}

export function canContinueProAgentRunWithPremium(
  extraUsageConfig: ExtraUsageConfig | undefined,
): boolean {
  if (!extraUsageConfig?.enabled) return false;
  if (
    extraUsageConfig.monthlyRemainingDollars !== undefined &&
    extraUsageConfig.monthlyRemainingDollars <= 0
  ) {
    return false;
  }

  return Boolean(
    extraUsageConfig.hasBalance || extraUsageConfig.autoReloadEnabled,
  );
}

export function isPremiumAgentContinuationModel(
  selectedModel: SelectedModel | undefined,
): boolean {
  return selectedModel === "hackerai-pro" || selectedModel === "hackerai-max";
}

export function resolveAgentRunSpendCapContinuationModel(args: {
  finishReason: string | null | undefined;
  isAutoContinue: boolean | undefined;
  mode: ChatMode;
  subscription: SubscriptionTier;
  selectedModelOverride: SelectedModel | undefined;
  extraUsageConfig: ExtraUsageConfig | undefined;
}): SelectedModel | undefined {
  const {
    finishReason,
    isAutoContinue,
    mode,
    subscription,
    selectedModelOverride,
    extraUsageConfig,
  } = args;

  if (
    finishReason !== AGENT_RUN_SPEND_CAP_FINISH_REASON ||
    !isAutoContinue ||
    mode !== "agent" ||
    subscription !== "pro" ||
    !isPremiumAgentContinuationModel(selectedModelOverride) ||
    canContinueProAgentRunWithPremium(extraUsageConfig)
  ) {
    return selectedModelOverride;
  }

  return AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL;
}
