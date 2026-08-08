import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import type { AgentNetworkConfig, SubscriptionTier } from "@/types";

export async function loadE2BNetworkConfig(args: {
  userId: string;
  serviceKey?: string;
  subscription?: SubscriptionTier;
}): Promise<AgentNetworkConfig | null> {
  if (!args.serviceKey || !args.subscription || args.subscription === "free") {
    return null;
  }

  return getConvexClient().action(
    api.e2bNetworkConfigActions.getE2BNetworkConfigForBackend,
    {
      serviceKey: args.serviceKey,
      userId: args.userId,
      subscription: args.subscription,
    },
  );
}
