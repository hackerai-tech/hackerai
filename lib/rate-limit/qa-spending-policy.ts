import { ChatSDKError } from "@/lib/errors";
import {
  getLimitPressureContext,
  type LimitCapReason,
} from "@/lib/limit-pressure";
import {
  isPaidIndividualSubscription,
  type RateLimitInfo,
  type SubscriptionTier,
} from "@/types";
import { NORMAL_USAGE_MULTIPLIER, POINTS_PER_DOLLAR } from "./usage-pricing";

/**
 * Routine QA quota exemption.
 *
 * Explicitly listed WorkOS users on a personal paid plan draw from one shared,
 * capped QA pool instead of their own included-usage bucket, and never from an
 * Extra Usage wallet. The policy only activates in a verified Preview or
 * Development runtime; any missing, malformed or contradictory configuration
 * leaves normal customer billing in place. Free limits, Team seats, tier, model
 * entitlement, concurrency and per-run caps are decided elsewhere and unchanged.
 *
 * Configuration (all server-side):
 * - QA_MONTHLY_QUOTA_USER_IDS: comma-separated exact WorkOS user IDs.
 * - QA_MONTHLY_QUOTA_DENY_USER_IDS: optional IDs that must never be exempt,
 *   such as billing fixtures. Any overlap with the allow list disables the
 *   whole policy.
 * - QA_SPEND_CAP_DOLLARS: positive raw provider/tool spend cap per pool window.
 * - HACKERAI_ENVIRONMENT: "preview" or "development"; must agree with the
 *   provider-owned identity and test WorkOS credentials below.
 *
 * Runtime identity: Vercel sets VERCEL_ENV/VERCEL_TARGET_ENV, and Trigger.dev
 * provides each worker its own environment's TRIGGER_SECRET_KEY. Production
 * values, custom Vercel targets (e.g. staging) and Trigger keys for any other
 * environment deny the exemption. Request payloads and headers never select it.
 */

export type QaSpendPoolEnvironment = NonNullable<RateLimitInfo["qaSpendPool"]>;

export type QaSpendPool = {
  environment: QaSpendPoolEnvironment;
  /** Shared Redis paid-bucket key for this environment's QA pool. */
  storageKey: string;
  /** Pool capacity in included-usage points (billable, multiplier applied). */
  capPoints: number;
};

export type QaSpendPolicyStatus =
  | { status: "disabled" }
  | { status: "misconfigured"; reason: string }
  | { status: "inactive_environment" }
  | {
      status: "active";
      environment: QaSpendPoolEnvironment;
      userIds: ReadonlySet<string>;
      capPoints: number;
    };

type PolicyEnv = Readonly<Record<string, string | undefined>>;

export const QA_SPEND_CAP_REASON = "qa_spend_cap";

const QA_SPEND_POOL_KEYS: Record<QaSpendPoolEnvironment, string> = {
  preview: "usage:qa-spend:v1:preview",
  development: "usage:qa-spend:v1:development",
};

const TRIGGER_KEY_PREFIXES: Record<QaSpendPoolEnvironment, string> = {
  preview: "tr_preview_",
  development: "tr_dev_",
};

// WorkOS user IDs are `user_` followed by a 26-character ULID. Exact matching
// rejects emails, wildcards and partial IDs.
const WORKOS_USER_ID_PATTERN = /^user_[0-9A-Z]{26}$/;
// Plain decimal dollars only: rejects Infinity, exponents, signs and blanks.
const DOLLAR_AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

const parseUserIdList = (
  raw: string | undefined,
): { ids: Set<string> } | { error: string } => {
  const ids = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const id = entry.trim();
    if (!id) continue;
    if (!WORKOS_USER_ID_PATTERN.test(id)) {
      return { error: "invalid_user_id" };
    }
    ids.add(id);
  }
  return { ids };
};

const parseCapPoints = (raw: string | undefined): number | null => {
  const value = raw?.trim();
  if (!value || !DOLLAR_AMOUNT_PATTERN.test(value)) return null;
  const dollars = Number(value);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  const points = Math.floor(
    Number((dollars * POINTS_PER_DOLLAR * NORMAL_USAGE_MULTIPLIER).toFixed(6)),
  );
  return Number.isSafeInteger(points) && points >= 1 ? points : null;
};

/**
 * Resolve the runtime only from provider-owned identity plus the trusted
 * deployment label. Returns null for production, staging, unknown or
 * contradictory runtimes.
 */
export const resolveVerifiedQaEnvironment = (
  env: PolicyEnv,
): QaSpendPoolEnvironment | null => {
  const declared = env.HACKERAI_ENVIRONMENT?.trim();
  if (declared !== "preview" && declared !== "development") return null;
  if (!env.WORKOS_API_KEY?.startsWith("sk_test_")) return null;

  const vercelEnv = env.VERCEL_ENV?.trim() || undefined;
  const vercelTarget = env.VERCEL_TARGET_ENV?.trim() || undefined;
  if (vercelEnv === "production" || vercelTarget === "production") return null;
  // Custom Vercel environments (staging and others) report VERCEL_ENV=preview
  // with a distinct target; they are not the shared Preview environment.
  if (vercelTarget !== undefined && vercelTarget !== vercelEnv) return null;
  if (vercelEnv !== undefined && vercelEnv !== declared) return null;
  // A Preview app needs Vercel's exact target; a worker needs Trigger's
  // managed deployment marker. A Preview API key alone is not a host identity.
  if (
    declared === "preview" &&
    !env.TRIGGER_DEPLOYMENT_VERSION &&
    (env.VERCEL !== "1" || vercelEnv !== declared || vercelTarget !== declared)
  ) {
    return null;
  }

  // Both Vercel and Trigger runtimes carry the Trigger key for the Trigger
  // environment they talk to; Trigger workers receive their own environment's
  // key. A production or staging key always denies.
  const triggerKey = env.TRIGGER_SECRET_KEY;
  if (!triggerKey?.startsWith(TRIGGER_KEY_PREFIXES[declared])) return null;

  return declared;
};

export const getQaSpendPolicyStatus = (
  env: PolicyEnv = process.env,
): QaSpendPolicyStatus => {
  const allowed = parseUserIdList(env.QA_MONTHLY_QUOTA_USER_IDS);
  if ("error" in allowed) {
    return { status: "misconfigured", reason: "invalid_allow_list" };
  }
  if (allowed.ids.size === 0) return { status: "disabled" };

  const denied = parseUserIdList(env.QA_MONTHLY_QUOTA_DENY_USER_IDS);
  if ("error" in denied) {
    return { status: "misconfigured", reason: "invalid_deny_list" };
  }
  for (const id of allowed.ids) {
    if (denied.ids.has(id)) {
      return { status: "misconfigured", reason: "allow_deny_overlap" };
    }
  }

  const capPoints = parseCapPoints(env.QA_SPEND_CAP_DOLLARS);
  if (capPoints === null) {
    return { status: "misconfigured", reason: "invalid_spend_cap" };
  }

  const environment = resolveVerifiedQaEnvironment(env);
  if (!environment) return { status: "inactive_environment" };

  return { status: "active", environment, userIds: allowed.ids, capPoints };
};

const warnedPolicyStates = new Set<string>();

const warnOncePerProcess = (status: QaSpendPolicyStatus) => {
  if (status.status !== "misconfigured") return;
  if (warnedPolicyStates.has(status.reason)) return;
  warnedPolicyStates.add(status.reason);
  // Never log the configured IDs or cap; the reason identifies the fix.
  console.warn(
    `[qa-spending-policy] QA quota exemption disabled: ${status.reason}`,
  );
};

/**
 * Return the shared QA pool for this request, or null for normal billing.
 * Only personal paid plans are eligible; Free and Team keep their own limits.
 */
export const resolveQaSpendPool = (
  userId: string,
  subscription: SubscriptionTier,
  env: PolicyEnv = process.env,
): QaSpendPool | null => {
  if (!isPaidIndividualSubscription(subscription)) return null;
  const status = getQaSpendPolicyStatus(env);
  warnOncePerProcess(status);
  if (status.status !== "active" || !status.userIds.has(userId)) return null;
  return {
    environment: status.environment,
    storageKey: QA_SPEND_POOL_KEYS[status.environment],
    capPoints: status.capPoints,
  };
};

/**
 * Limit metadata for the QA pool. It deliberately omits Extra Usage, upgrade
 * and paid daily allowance signals: none of them apply to a QA cap.
 */
export const qaSpendCapMetadata = (
  pool: Pick<QaSpendPool, "environment">,
  subscription: SubscriptionTier,
  resetTimestamp?: number,
  capReason: LimitCapReason = QA_SPEND_CAP_REASON,
) => ({
  ...(resetTimestamp !== undefined && { resetTimestamp }),
  subscription,
  capReason,
  qaSpendPool: pool.environment,
  extraUsageEnabled: false,
  extraUsageHasBalance: false,
  extraUsageAutoReloadEnabled: false,
  ...getLimitPressureContext({ subscription, capReason }),
});

export const createQaSpendCapError = (
  pool: Pick<QaSpendPool, "environment">,
  subscription: SubscriptionTier,
  resetTimestamp?: number,
): ChatSDKError =>
  new ChatSDKError(
    "rate_limit:chat",
    "The shared QA spending pool for this environment is exhausted. QA requests resume when the pool refills.",
    qaSpendCapMetadata(pool, subscription, resetTimestamp),
  );

export const createQaSpendPoolUnavailableError = (
  pool: Pick<QaSpendPool, "environment">,
  subscription: SubscriptionTier,
): ChatSDKError =>
  new ChatSDKError(
    "rate_limit:chat",
    "The shared QA spending pool is unavailable. Try again or ask the QA owner to check its configuration.",
    qaSpendCapMetadata(pool, subscription, undefined, "billing_unavailable"),
  );
