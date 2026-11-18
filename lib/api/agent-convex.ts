import { getConvexClient, type ConvexCallScope } from "@/lib/db/convex-client";

/**
 * Convex transport deadlines for Agent start and status requests. Each phase
 * gets a fresh client and deadline, so a write cannot spend the budget of the
 * read-back that decides its outcome. The deadline aborts the real fetch,
 * including before response headers, and also bounds helper retry sleeps.
 *
 * These are Convex budgets within the 30s status and 60s start routes.
 * Authentication, Trigger calls and other services have their own timing.
 */
export const AGENT_CONVEX_DEADLINES_MS = {
  statusOwnershipRead: 5_000,
  statusTerminalCleanup: 5_000,
  startChatRead: 4_000,
  // Includes the Trigger read between the goal read and its settlement.
  startGoalReconciliation: 6_000,
  // Goal reservation, chat/message persistence and the goal message marker,
  // including the existing write retries.
  startPersistence: 10_000,
  startPreviousOwnerRead: 4_000,
  startAssociation: 6_000,
  startAssociationReadBack: 4_000,
  startCleanup: 4_000,
  startGoalRelease: 4_000,
} as const;

type AgentConvexPhase = keyof typeof AGENT_CONVEX_DEADLINES_MS;

/**
 * Run one phase of one request on an isolated, deadline-bound Convex client.
 * The deadline ends with the phase, so finished requests retain no timers.
 */
export async function withAgentConvexScope<T>(
  phase: AgentConvexPhase,
  operation: (scope: ConvexCallScope) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  // Named like AbortSignal.timeout's reason so callers classify it the same
  // way. fetch rejects with this reason, and the service client rethrows it.
  const timer = setTimeout(
    () =>
      controller.abort(
        Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        }),
      ),
    AGENT_CONVEX_DEADLINES_MS[phase],
  );
  try {
    return await operation({
      client: getConvexClient(controller.signal),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
