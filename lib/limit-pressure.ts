import type { SubscriptionTier } from "@/types";

export type LimitCapReason =
  | "daily_requests_exhausted"
  | "free_monthly_exhausted"
  | "monthly_exhausted"
  | "extra_usage_cap"
  | "team_member_cap"
  | "team_member_disabled"
  | "team_pool_disabled"
  | "auto_reload_failed"
  | "billing_unavailable"
  | "monthly_near_limit"
  | "extra_usage_active"
  | "agent_run_spend_cap"
  | (string & {});

export type LimitType =
  | "daily_requests"
  | "free_monthly"
  | "monthly"
  | "extra_usage"
  | "team_extra_usage"
  | "billing";

export type LimitCta =
  | "upgrade_plan"
  | "add_credits"
  | "increase_spending_limit"
  | "update_payment_method"
  | "open_team_extra_usage";

export type ExtraUsageLimitCta = {
  label: string;
  analyticsText: string;
  settingsTab: "Extra Usage" | "Usage";
};

const UPGRADABLE_TIERS = new Set<SubscriptionTier>(["free", "pro", "pro-plus"]);

const DIRECT_EXTRA_USAGE_REASONS = new Set<string>([
  "monthly_exhausted",
  "monthly_near_limit",
]);

const MONTHLY_CAP_HIT_REASONS = new Set<string>([
  "monthly_exhausted",
  "extra_usage_cap",
  "team_member_cap",
]);

const COST_GUARDRAIL_REASONS = new Set<string>([
  "extra_usage_cap",
  "team_member_cap",
  "team_member_disabled",
  "team_pool_disabled",
  "auto_reload_failed",
]);

export function getLimitTypeForCapReason(
  capReason: LimitCapReason | undefined,
): LimitType {
  if (!capReason) return "monthly";
  if (capReason.includes("daily")) return "daily_requests";
  if (capReason === "free_monthly_exhausted") return "free_monthly";
  if (
    capReason === "team_member_cap" ||
    capReason === "team_member_disabled" ||
    capReason === "team_pool_disabled"
  ) {
    return "team_extra_usage";
  }
  if (
    capReason === "extra_usage_cap" ||
    capReason === "auto_reload_failed" ||
    capReason === "extra_usage_active"
  ) {
    return "extra_usage";
  }
  if (capReason === "billing_unavailable") return "billing";
  return "monthly";
}

export function isCostGuardrailCapReason(
  capReason: LimitCapReason | undefined,
): boolean {
  return !!capReason && COST_GUARDRAIL_REASONS.has(capReason);
}

export function isPaidMonthlyCapHitReason(
  capReason: LimitCapReason | undefined,
): boolean {
  return !!capReason && MONTHLY_CAP_HIT_REASONS.has(capReason);
}

export function isPaidMonthlyExhaustionReason(
  capReason: LimitCapReason | undefined,
): boolean {
  return capReason === "monthly_exhausted";
}

export function shouldShowUpgradeCta(args: {
  subscription: SubscriptionTier;
  capReason?: LimitCapReason;
}): boolean {
  const { subscription, capReason } = args;
  if (!UPGRADABLE_TIERS.has(subscription)) return false;
  if (subscription === "free") return true;

  return !capReason || DIRECT_EXTRA_USAGE_REASONS.has(capReason);
}

export function getExtraUsageLimitCta(args: {
  subscription: SubscriptionTier;
  capReason?: LimitCapReason;
}): ExtraUsageLimitCta | null {
  const { subscription, capReason } = args;
  if (subscription === "free") return null;

  if (capReason === "extra_usage_cap") {
    return {
      label: "Increase Limit",
      analyticsText: "Increase Limit",
      settingsTab: "Extra Usage",
    };
  }

  if (capReason === "auto_reload_failed") {
    return {
      label: "Update Payment",
      analyticsText: "Update Payment",
      settingsTab: "Extra Usage",
    };
  }

  if (capReason === "team_pool_disabled") {
    return {
      label: "Team Usage",
      analyticsText: "Open Team Usage",
      settingsTab: "Extra Usage",
    };
  }

  if (capReason === "team_member_cap" || capReason === "team_member_disabled") {
    return null;
  }

  if (capReason === "billing_unavailable") {
    return null;
  }

  return {
    label: "Add Credits",
    analyticsText: "Add Credits",
    settingsTab: "Extra Usage",
  };
}

export function getEligibleLimitCtas(args: {
  subscription: SubscriptionTier;
  capReason?: LimitCapReason;
}): LimitCta[] {
  const ctas: LimitCta[] = [];
  const extraUsageCta = getExtraUsageLimitCta(args);
  if (extraUsageCta?.analyticsText === "Add Credits") {
    ctas.push("add_credits");
  } else if (extraUsageCta?.analyticsText === "Increase Limit") {
    ctas.push("increase_spending_limit");
  } else if (extraUsageCta?.analyticsText === "Update Payment") {
    ctas.push("update_payment_method");
  } else if (extraUsageCta?.analyticsText === "Open Team Usage") {
    ctas.push("open_team_extra_usage");
  }

  if (shouldShowUpgradeCta(args)) ctas.push("upgrade_plan");

  return ctas;
}

export function getLimitPressureContext(args: {
  subscription: SubscriptionTier;
  capReason?: LimitCapReason;
}) {
  const { subscription, capReason } = args;
  const eligibleCtas = getEligibleLimitCtas(args);

  return {
    limitType: getLimitTypeForCapReason(capReason),
    costGuardrail: isCostGuardrailCapReason(capReason),
    paidMonthlyExhaustion:
      subscription !== "free" && isPaidMonthlyExhaustionReason(capReason),
    upgradeAvailable: eligibleCtas.includes("upgrade_plan"),
    addCreditAvailable: eligibleCtas.includes("add_credits"),
    primaryCta: eligibleCtas[0],
    eligibleCtas,
  };
}
