import type { SubscriptionTier } from "@/types";
// Keep this static: Trigger's split CJS bundle exposes only a default export
// for dynamic imports, so destructuring Sandbox at runtime can yield undefined.
import { Sandbox } from "@e2b/code-interpreter";
import {
  getConfiguredE2BClustersForCleanup,
  type E2BCluster,
} from "./e2b-cluster";

export type MiosaDiscoveryFailure = {
  cluster: E2BCluster;
  kind:
    | "missing_credentials"
    | "timeout"
    | "authentication"
    | "rate_limit"
    | "http_error"
    | "request_error"
    | "deadline"
    | "pagination_limit";
  httpStatus?: number;
  elapsedMs: number;
};

// Provider error messages can contain response bodies, URLs, and credentials.
// Preserve only bounded categories and a numeric HTTP status, never the cause.
function classifyDiscoveryError(
  error: unknown,
): Pick<MiosaDiscoveryFailure, "kind" | "httpStatus"> {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  const status = /^([45]\d\d):/.exec(message)?.[1];
  const httpStatus = status ? Number(status) : undefined;
  if (
    name === "AuthenticationError" ||
    httpStatus === 401 ||
    httpStatus === 403
  ) {
    return { kind: "authentication", httpStatus: httpStatus ?? 401 };
  }
  if (name === "TimeoutError" || name === "AbortError")
    return { kind: "timeout" };
  if (name === "RateLimitError" || httpStatus === 429)
    return { kind: "rate_limit", httpStatus: 429 };
  return httpStatus
    ? { kind: "http_error", httpStatus }
    : { kind: "request_error" };
}

export type MiosaEnrollmentReason =
  "not_pro" | "existing_e2b_workspace" | "workspace_discovery_unavailable";

/** An enrollment veto is not a MIOSA acquisition failure. */
export class MiosaEnrollmentError extends Error {
  constructor(
    readonly reason: MiosaEnrollmentReason,
    readonly discoveryFailure?: MiosaDiscoveryFailure,
  ) {
    super(`MIOSA new-workspace enrollment denied: ${reason}`);
    this.name = "MiosaEnrollmentError";
  }
}

/**
 * Admit new Pro and Pro+ workspaces only after authoritative, read-only E2B discovery.
 * Paused workspaces and older templates still contain user data. Never delete
 * or resume them to make a user eligible. Metadata checks span configured
 * clusters; execution remains restricted to the request's approved region.
 */
export async function assertFreshMiosaEnrollment(options: {
  userId: string;
  subscription?: SubscriptionTier;
}): Promise<void> {
  if (options.subscription !== "pro" && options.subscription !== "pro-plus") {
    throw new MiosaEnrollmentError("not_pro");
  }
  // Without the default E2B account, an empty cluster list proves nothing.
  if (!process.env.E2B_API_KEY?.trim()) {
    throw new MiosaEnrollmentError("workspace_discovery_unavailable", {
      cluster: "us",
      kind: "missing_credentials",
      elapsedMs: 0,
    });
  }
  const startedAt = Date.now();
  const deadline = startedAt + 5000;
  let clusterName: E2BCluster = "us";
  const deny = (kind: MiosaDiscoveryFailure["kind"]) =>
    new MiosaEnrollmentError("workspace_discovery_unavailable", {
      cluster: clusterName,
      kind,
      elapsedMs: Date.now() - startedAt,
    });
  try {
    for (const cluster of getConfiguredE2BClustersForCleanup()) {
      clusterName = cluster.cluster;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw deny("deadline");
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
        if (++pages > 10) throw deny("pagination_limit");
        const pageRemainingMs = deadline - Date.now();
        if (pageRemainingMs <= 0) throw deny("deadline");
        if (
          (
            await paginator.nextItems({
              requestTimeoutMs: Math.min(pageRemainingMs, 2500),
            })
          ).length > 0
        ) {
          throw new MiosaEnrollmentError("existing_e2b_workspace");
        }
        if (Date.now() >= deadline) throw deny("deadline");
      } while (paginator.hasNext);
    }
  } catch (error) {
    if (error instanceof MiosaEnrollmentError) throw error;
    // Do not expose provider response bodies or treat failed reads as absence.
    throw new MiosaEnrollmentError("workspace_discovery_unavailable", {
      cluster: clusterName,
      ...classifyDiscoveryError(error),
      elapsedMs: Date.now() - startedAt,
    });
  }
}
