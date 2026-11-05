import type { PostHog } from "posthog-node";
import type { ModelName } from "@/lib/ai/providers";
import { DEEPSEEK_1017_SLUG } from "./paid-deepseek-1017";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";

export const FREE_ASK_DEEPSEEK_1017_KEY =
  "free_ask_deepseek_1017_conversion_v2";
export const FREE_ASK_MODEL_OUTCOME_EVENT = "free_ask_model_response_outcome";

/** Called after Free Ask eligibility and competing model policies are resolved. */
export async function evaluateFreeAskDeepSeek1017(
  posthog: Pick<PostHog, "getFeatureFlagResult">,
  userId: string,
) {
  const variant = await getPostHogFlagWithoutExposure(
    posthog,
    FREE_ASK_DEEPSEEK_1017_KEY,
    userId,
    { subscription: "free", subscription_tier: "free" },
  );
  if (variant !== "control" && variant !== "test") return undefined;
  return {
    key: FREE_ASK_DEEPSEEK_1017_KEY,
    variant,
    // This Free Ask alias uses the exact 1017 snapshot and preserves low
    // reasoning, recovery, and cost accounting independently of paid routing.
    modelKey: (variant === "test"
      ? "ask-model-free-deepseek-v41"
      : "ask-model-free-glm") as ModelName,
    configuredModel:
      variant === "test" ? DEEPSEEK_1017_SLUG : "z-ai/glm-5.3-flash",
  } as const;
}
