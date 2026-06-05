export const PAID_FUNNEL_EVENT_VERSION = 1;

export const PAID_FUNNEL_EVENTS = {
  upgradeCtaImpressed: "upgrade_cta_impressed",
  upgradeCtaClicked: "upgrade_cta_clicked",
  addCreditCtaImpressed: "add_credit_cta_impressed",
  addCreditCtaClicked: "add_credit_cta_clicked",
  addCreditCheckoutStarted: "add_credit_checkout_started",
  addCreditCheckoutSucceeded: "add_credit_checkout_succeeded",
  checkoutStarted: "checkout_started",
  checkoutSucceeded: "checkout_succeeded",
  limitHit: "limit_hit",
} as const;

export type PaidFunnelPlan =
  | "pro-monthly-plan"
  | "pro-plus-monthly-plan"
  | "ultra-monthly-plan"
  | "pro-yearly-plan"
  | "pro-plus-yearly-plan"
  | "ultra-yearly-plan"
  | "team-monthly-plan"
  | "team-yearly-plan";

export type PaidFunnelTier = "free" | "pro" | "pro-plus" | "ultra" | "team";

export function planLookupKeyToTier(
  lookupKey: string | undefined,
): Exclude<PaidFunnelTier, "free"> | null {
  if (!lookupKey) return null;
  if (lookupKey.startsWith("ultra")) return "ultra";
  if (lookupKey.startsWith("pro-plus")) return "pro-plus";
  if (lookupKey.startsWith("team")) return "team";
  if (lookupKey.startsWith("pro")) return "pro";
  return null;
}

export function planLookupKeyToBillingInterval(
  lookupKey: string | undefined,
): "month" | "year" | undefined {
  if (!lookupKey) return undefined;
  if (lookupKey.includes("yearly")) return "year";
  if (lookupKey.includes("monthly")) return "month";
  return undefined;
}

export function normalizePaidFunnelLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(trimmed)) return undefined;
  return trimmed;
}

export function paidFunnelTierFromUnknown(
  value: unknown,
  fallback: PaidFunnelTier = "free",
): PaidFunnelTier {
  return value === "free" ||
    value === "pro" ||
    value === "pro-plus" ||
    value === "ultra" ||
    value === "team"
    ? value
    : fallback;
}

export function createCheckoutAttemptId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `ca_${uuid}`;

  return `ca_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

export function normalizeCheckoutAttemptId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(trimmed)) return undefined;
  return trimmed;
}

export function paidFunnelProperties(properties: Record<string, unknown> = {}) {
  return {
    ...properties,
    paid_funnel_event_version: PAID_FUNNEL_EVENT_VERSION,
  };
}
