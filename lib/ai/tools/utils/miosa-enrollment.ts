import type { SubscriptionTier } from "@/types";
import { getConfiguredE2BClustersForCleanup } from "./e2b-cluster";

export type MiosaEnrollmentReason =
  "not_pro" | "existing_e2b_workspace" | "workspace_discovery_unavailable";

/** An enrollment veto is not a MIOSA acquisition failure. */
export class MiosaEnrollmentError extends Error {
  constructor(readonly reason: MiosaEnrollmentReason) {
    super(`MIOSA new-workspace enrollment denied: ${reason}`);
    this.name = "MiosaEnrollmentError";
  }
}

/**
 * Admit new Pro workspaces only after authoritative, read-only E2B discovery.
 * Paused workspaces and older templates still contain user data. Never delete
 * or resume them to make a user eligible. Metadata checks span configured
 * clusters; execution remains restricted to the request's approved region.
 */
export async function assertFreshMiosaEnrollment(options: {
  userId: string;
  subscription?: SubscriptionTier;
}): Promise<void> {
  if (options.subscription !== "pro") {
    throw new MiosaEnrollmentError("not_pro");
  }
  // Without the default E2B account, an empty cluster list proves nothing.
  if (!process.env.E2B_API_KEY?.trim()) {
    throw new MiosaEnrollmentError("workspace_discovery_unavailable");
  }
  const deadline = Date.now() + 5000;
  try {
    const { Sandbox } = await import("@e2b/code-interpreter");
    for (const cluster of getConfiguredE2BClustersForCleanup()) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("Discovery deadline exceeded");
      const paginator = Sandbox.list({
        ...cluster.connectionOptions,
        requestTimeoutMs: Math.min(remainingMs, 2500),
        query: {
          metadata: { userID: options.userId },
          state: ["running", "paused"],
        },
        limit: 1,
      });
      let pages = 0;
      do {
        if (++pages > 10 || Date.now() >= deadline) {
          throw new Error("Incomplete workspace discovery");
        }
        if ((await paginator.nextItems()).length > 0) {
          throw new MiosaEnrollmentError("existing_e2b_workspace");
        }
      } while (paginator.hasNext);
    }
  } catch (error) {
    if (error instanceof MiosaEnrollmentError) throw error;
    // Do not expose provider response bodies or treat failed reads as absence.
    throw new MiosaEnrollmentError("workspace_discovery_unavailable");
  }
}
