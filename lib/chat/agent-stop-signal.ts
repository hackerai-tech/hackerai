type DirectStopSource =
  | "trigger_platform"
  | "active_runtime_budget"
  | "auto_review_circuit_breaker"
  | "post_wait_authorization_denied"
  | "usage_settlement_uncovered";

type StreamStopSource = "agent_run_spend_cap" | "budget_monitor";

export type AgentStopSignalSource =
  DirectStopSource | StreamStopSource | "unattributed";

/** Observe the first stop without changing its reason or cancellation semantics. */
export function createAgentStopSignal({
  onAbort,
  getStreamState,
}: {
  onAbort: (source: AgentStopSignalSource) => void;
  getStreamState: () =>
    | {
        stoppedDueToAgentRunSpendCap?: boolean;
        stoppedDueToBudgetExhaustion?: boolean;
      }
    | undefined;
}) {
  const controller = new AbortController();
  let directSource: DirectStopSource | undefined;
  const reportAbort = () => {
    let source: AgentStopSignalSource = directSource ?? "unattributed";
    if (!directSource) {
      try {
        // The shared runner sets these flags synchronously before aborting.
        const state = getStreamState();
        source = state?.stoppedDueToAgentRunSpendCap
          ? "agent_run_spend_cap"
          : state?.stoppedDueToBudgetExhaustion
            ? "budget_monitor"
            : "unattributed";
      } catch {
        // Attribution must never interfere with cancellation.
      }
    }
    try {
      // Never pass signal.reason: platform/provider reasons may contain content.
      onAbort(source);
    } catch {
      // Logging must never interfere with cancellation or cleanup.
    }
  };
  controller.signal.addEventListener("abort", reportAbort, { once: true });

  return {
    controller,
    abort(source: DirectStopSource, reason?: unknown) {
      if (!controller.signal.aborted) directSource = source;
      controller.abort(reason);
    },
    dispose() {
      controller.signal.removeEventListener("abort", reportAbort);
    },
  };
}
