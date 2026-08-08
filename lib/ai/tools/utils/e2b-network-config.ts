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

export async function acquireE2BNetworkMigrationLease(args: {
  userId: string;
  serviceKey: string;
}): Promise<(() => Promise<void>) | null> {
  const client = getConvexClient();
  const leaseId = crypto.randomUUID();
  const acquired = await client.action(
    api.e2bNetworkConfigActions.acquireE2BNetworkMigrationLease,
    { ...args, leaseId },
  );
  if (!acquired) return null;

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.action(
        api.e2bNetworkConfigActions.releaseE2BNetworkMigrationLease,
        { ...args, leaseId },
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          event: "e2b_network_migration_lease_release_failed",
          service: "chat-handler",
          environment:
            process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
          request_id: process.env.VERCEL_REQUEST_ID ?? null,
          user_id: args.userId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
}
