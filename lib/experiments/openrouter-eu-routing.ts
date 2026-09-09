import type { PostHog } from "posthog-node";
import type { OpenRouterRegionOptions } from "@/lib/ai/openrouter-region";

export const OPENROUTER_EU_ROUTING_FLAG = "openrouter_eu_routing_v1";

/** Resolves rollout assignment; exposure is deferred until actual EU inference. */
export async function resolveOpenRouterRegionOptions({
  posthog,
  userId,
  isEuropeanUser,
}: {
  posthog: Pick<PostHog, "evaluateFlags" | "capture"> | null;
  userId: string;
  isEuropeanUser: boolean;
}): Promise<OpenRouterRegionOptions> {
  if (!isEuropeanUser || !posthog) return {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const flags = await Promise.race([
      posthog.evaluateFlags(userId, {
        flagKeys: [OPENROUTER_EU_ROUTING_FLAG],
      }),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 1_000);
      }),
    ]);
    if (flags?.getFlag(OPENROUTER_EU_ROUTING_FLAG) !== true) return {};
    let exposed = false;
    return {
      preferEurope: true,
      onRoute(outcome) {
        if (outcome === "eu" && exposed) return;
        if (outcome === "eu") exposed = true;
        posthog.capture({
          distinctId: userId,
          event:
            outcome === "eu"
              ? "openrouter_eu_routing_exposed"
              : "openrouter_eu_routing_global_fallback",
          properties: {
            [`$feature/${OPENROUTER_EU_ROUTING_FLAG}`]: true,
            route_outcome: outcome,
            $process_person_profile: false,
          },
        });
      },
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}
