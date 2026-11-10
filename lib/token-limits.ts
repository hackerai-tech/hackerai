import { FREE_MAX_CONTEXT_TOKENS } from "@/lib/rate-limit/free-config";
import type { ChatMode, SubscriptionTier } from "@/types";

export const MAX_TOKENS_FREE = FREE_MAX_CONTEXT_TOKENS;
// Keep 256K tokens before compaction, plus the 20K compaction reserve.
export const MAX_TOKENS_PAID = 276_000;

/**
 * Percentage of context window budget allocated to file uploads in Ask mode.
 * Leaves remaining budget for conversation history, system prompt, and model output.
 */
export const FILE_TOKEN_PERCENT = 0.5;

export const getMaxTokensForSubscription = (
  subscription?: SubscriptionTier,
  _opts?: { mode?: ChatMode },
): number => {
  if (process.env.NEXT_PUBLIC_SELF_HOSTED === "true")
    return Number(process.env.LOCAL_CONTEXT_BUDGET ?? 8192);
  if (subscription === "free") return MAX_TOKENS_FREE;
  return MAX_TOKENS_PAID;
};

/**
 * Maximum total tokens allowed across all uploaded files in Ask mode.
 * Scales with the subscription's context window budget.
 */
export const getMaxFileTokens = (
  subscription: SubscriptionTier,
  opts?: { mode?: ChatMode },
): number => {
  return Math.floor(
    getMaxTokensForSubscription(subscription, opts) * FILE_TOKEN_PERCENT,
  );
};
