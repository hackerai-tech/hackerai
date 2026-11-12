import {
  AGENT_MODEL_CONTEXT_FLAG,
  type AgentModelContextVariant,
  type AgentModelContextFlag,
} from "@/lib/experiments/agent-model-context";
import type { PostHog } from "posthog-node";
import { v5 as uuidv5 } from "uuid";
import { selectedComputerFailureDiagnostics } from "@/lib/sandbox/selected-computer-diagnostics";
import { knownIncurredCostLowerBound } from "@/lib/analytics/serving-cost";
import {
  getLocalStopDiagnostic,
  LOCAL_CONNECTION_LOST_FINISH_REASON,
  localStopAnalyticsProperties,
} from "@/lib/chat/local-connection-stop";

type RunEvent =
  | "hackerai-agent_run"
  | "hackerai-usage_cost"
  | "hackerai-usage_cost_observation";
type FailureStage = "setup" | "preparation" | "model_stream";
type FailureKind = "error" | "canceled" | "usage_limit" | "elapsed_timeout";

/** Shared by normal completion and fallback capture, including retransmission. */
export const agentRunEventUuid = (runId: string, event: RunEvent) =>
  uuidv5(`hackerai:agent-run:v1:${runId}:${event}`, uuidv5.URL);

function field(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Only fixed categories leave this boundary, never arbitrary error content. */
export function agentFailureCategory(error: unknown): string {
  const seen = new Set<unknown>();
  let category = "unknown";
  for (let depth = 0; error != null && depth < 6; depth++) {
    if (seen.has(error)) break;
    seen.add(error);
    const message = typeof error === "string" ? error : field(error, "message");
    const code = field(error, "code");
    if (
      code === "TooManyConcurrentRequests" ||
      (typeof message === "string" &&
        /TooManyConcurrentRequests|Too many concurrent requests/.test(message))
    )
      return "database_concurrency";
    if (field(error, "surface") === "database") category = "database";
    else if (
      field(error, "type") === "offline" &&
      field(error, "surface") === "sandbox"
    )
      category = "sandbox_offline";
    else if (code === "InternalServerError" && category === "unknown")
      category = "server_error";
    else if (field(error, "name") === "TimeoutError" && category === "unknown")
      category = "timeout";
    else if (field(error, "name") === "AbortError" && category === "unknown")
      category = "abort";
    else if (field(error, "name") === "TypeError" && category === "unknown")
      category = "type_error";
    const providerCategory = field(error, "category");
    if (
      category === "unknown" &&
      typeof providerCategory === "string" &&
      [
        "timeout",
        "stream_terminated",
        "rate_limited",
        "content_blocked",
        "provider_5xx",
        "provider_4xx",
      ].includes(providerCategory)
    )
      category = providerCategory;
    error = field(error, "cause");
  }
  return category;
}

type FailureSignalContext = {
  trigger_aborted: boolean;
  stop_aborted: boolean;
  matches_trigger_reason: boolean;
  matches_stop_reason: boolean;
};

/** Compare standard signal identity only; never inspect, retain or export reasons. */
export function agentFailureSignalContext(
  error: unknown,
  triggerSignal: AbortSignal,
  stopSignal: AbortSignal,
): FailureSignalContext | undefined {
  try {
    const triggerAborted = triggerSignal.aborted;
    const stopAborted = stopSignal.aborted;
    if (typeof triggerAborted !== "boolean" || typeof stopAborted !== "boolean")
      return undefined;
    return {
      trigger_aborted: triggerAborted,
      stop_aborted: stopAborted,
      matches_trigger_reason: triggerAborted && error === triggerSignal.reason,
      matches_stop_reason: stopAborted && error === stopSignal.reason,
    };
  } catch {
    return undefined;
  }
}

const knownAmount = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/**
 * Owns reporting only. It must never retry settlement, issue refunds, or start
 * work to recover a cost. Independent guards retain a successful cost capture
 * when terminal capture fails (and vice versa).
 */
export function createAgentRunReporting(context: {
  posthog: PostHog | null;
  runId: string;
  userId: string;
  chatId: string;
  subscription: string;
  endpoint: string;
  isAutoContinue?: boolean;
  getFailureSignalContext?: (
    error: unknown,
  ) => FailureSignalContext | undefined;
}) {
  let stage: FailureStage = "setup";
  let agentModelContextFlag: AgentModelContextFlag = AGENT_MODEL_CONTEXT_FLAG;
  let agentModelContextVariant: AgentModelContextVariant | undefined;
  let failure:
    { stage: FailureStage; kind: FailureKind; category: string } | undefined;
  let selectedComputerDiagnostics:
    ReturnType<typeof selectedComputerFailureDiagnostics> | undefined;
  let failureSignals: FailureSignalContext | undefined;
  const captured = new Set<RunEvent>();
  let settlementCostCaptured = false;
  let terminalOutcome: "success" | "error" | "aborted" | undefined;
  let terminalAbortSource: string | undefined;
  let terminalFinishReason: string | undefined;
  let terminalStepLimitReached: boolean | undefined;
  // Holds only a constructed LocalConnectionLostError from the first abort.
  let localStop: object | undefined;

  function once<T>(event: RunEvent, capture: (args: T) => void, args: T) {
    if (captured.has(event)) return;
    try {
      capture(args);
      captured.add(event);
    } catch {
      // A failed analytics enqueue must not turn a settled run into a failure.
      // Leave this event eligible for the outer fallback.
    }
  }

  return {
    setAgentModelContextVariant(
      variant: AgentModelContextVariant | undefined,
      flag: AgentModelContextFlag = AGENT_MODEL_CONTEXT_FLAG,
    ) {
      agentModelContextFlag = flag;
      agentModelContextVariant = variant;
    },
    setStage(next: FailureStage) {
      stage = next;
    },
    /**
     * Call only with the first abort reason. A stop observed after the first
     * failure or terminal outcome (e.g. during error cleanup) did not end this
     * run and cannot attach a cause to that earlier result.
     */
    recordLocalStop(firstAbortReason: unknown) {
      if (localStop || failure || terminalOutcome) return;
      if (getLocalStopDiagnostic(firstAbortReason))
        localStop = firstAbortReason as object;
    },
    /** Keep the first failure's signal snapshot even if cleanup cancels later. */
    fail(error: unknown, kind: FailureKind = "error") {
      // Capture before ProviderTerminalError wrapping and cleanup exceptions.
      if (!failure) {
        selectedComputerDiagnostics = selectedComputerFailureDiagnostics(error);
        try {
          const observed = context.getFailureSignalContext?.(error);
          if (observed) {
            // Read only these four primitives once; never spread an observer object.
            const {
              trigger_aborted,
              stop_aborted,
              matches_trigger_reason,
              matches_stop_reason,
            } = observed;
            if (
              [
                trigger_aborted,
                stop_aborted,
                matches_trigger_reason,
                matches_stop_reason,
              ].every((value) => typeof value === "boolean")
            ) {
              failureSignals = {
                trigger_aborted,
                stop_aborted,
                matches_trigger_reason,
                matches_stop_reason,
              };
            }
          }
        } catch {
          /* Optional attribution cannot replace the original failure. */
        }
      }
      failure ??= { stage, kind, category: agentFailureCategory(error) };
    },
    captureTerminal<T>(capture: (args: T) => void, args: T) {
      const outcome = field(args, "outcome");
      if (
        outcome === "success" ||
        outcome === "error" ||
        outcome === "aborted"
      ) {
        terminalOutcome ??= outcome;
        // A failed enqueue must retain observed stream metadata, without
        // accepting arbitrary strings or inventing a natural completion.
        const finishReason = field(args, "finishReason");
        if (
          typeof finishReason === "string" &&
          [
            "stop",
            "length",
            "content-filter",
            "tool-calls",
            "error",
            "other",
            "unknown",
            LOCAL_CONNECTION_LOST_FINISH_REASON,
          ].includes(finishReason)
        )
          terminalFinishReason ??= finishReason;
        const stepLimitReached = field(
          field(args, "stepLimitTelemetry"),
          "stepLimitReached",
        );
        if (typeof stepLimitReached === "boolean")
          terminalStepLimitReached ??= stepLimitReached;
        const abortSource = field(args, "abortSource");
        if (
          typeof abortSource === "string" &&
          [
            "budget_exhausted",
            "agent_spend_cap",
            "elapsed_timeout",
            "user_wait_timeout",
            "user_wait_failed",
            "user_stop",
            "request_cancel",
            "unknown",
          ].includes(abortSource)
        ) {
          terminalAbortSource ??= abortSource;
        }
      }
      once(
        "hackerai-agent_run",
        capture,
        agentModelContextVariant || localStop
          ? {
              ...args,
              ...(agentModelContextVariant && {
                agentModelContextVariant,
                agentModelContextFlag,
              }),
              ...(localStop && { localConnectionLostError: localStop }),
            }
          : args,
      );
    },
    captureCost<T>(capture: (args: T) => void, args: T) {
      once(
        "hackerai-usage_cost",
        (value: T) => {
          capture(value);
          settlementCostCaptured = true;
        },
        args,
      );
    },
    /** Fill missing reports without changing outcomes, settlement or capture identity. */
    finalize(snapshot: {
      canceled: boolean;
      triggerCostDollars?: number;
      triggerDurationMs?: number;
      /** Legacy: provider-reported cost only; excludes estimates and retries. */
      observedAccumulatedCostDollars?: number;
      /** UsageTracker measurement, including discarded and estimated steps. */
      usageMeasurement?: {
        usage_known_incurred_cost_dollars?: number;
        usage_trigger_run_cost_dollars?: number;
      } & Record<string, unknown>;
    }) {
      if (!context.posthog) return;
      const costRecorded = settlementCostCaptured;
      const latestTriggerCost = knownAmount(snapshot.triggerCostDollars);
      const settledTriggerCost = knownAmount(
        snapshot.usageMeasurement?.usage_trigger_run_cost_dollars,
      );
      if (
        costRecorded &&
        latestTriggerCost !== null &&
        settledTriggerCost !== null
      ) {
        // The recorded event carries the settlement-time Trigger snapshot.
        // Only this run's later compute is additive to it.
        once(
          "hackerai-usage_cost_observation",
          () =>
            context.posthog!.capture({
              distinctId: context.userId,
              uuid: agentRunEventUuid(
                context.runId,
                "hackerai-usage_cost_observation",
              ),
              event: "hackerai-usage_cost_observation",
              properties: {
                observation_version: 1,
                trigger_run_id: context.runId,
                chat_id: context.chatId,
                subscription: context.subscription,
                subscription_tier: context.subscription,
                endpoint: context.endpoint,
                settled_trigger_cost_dollars: settledTriggerCost,
                latest_trigger_cost_dollars: latestTriggerCost,
                unrecorded_trigger_cost_dollars: Math.max(
                  0,
                  latestTriggerCost - settledTriggerCost,
                ),
                trigger_cost_is_final: false,
                $process_person_profile: false,
              },
            }),
          undefined,
        );
      }
      // A first local stop ends the run like a cancellation, not a failure.
      const kind =
        failure?.kind ??
        (snapshot.canceled || localStop ? "canceled" : "error");
      const outcome =
        terminalOutcome ?? (kind === "error" ? "error" : "aborted");
      const properties = {
        ...(agentModelContextVariant && {
          [`$feature/${agentModelContextFlag}`]: agentModelContextVariant,
        }),
        mode: "agent",
        subscription: context.subscription,
        subscription_tier: context.subscription,
        chat_id: context.chatId,
        trigger_run_id: context.runId,
        endpoint: context.endpoint,
        terminal_reporting_version: 1,
        run_metadata_version: 1,
        is_auto_continue: context.isAutoContinue ?? null,
        terminal_reporting_source: "run_finally",
        failure_stage: failure?.stage ?? stage,
        failure_category: failure?.category ?? "missing_finalization",
        failure_kind:
          failure?.kind ?? (snapshot.canceled || localStop ? "canceled" : null),
        ...selectedComputerDiagnostics,
        ...(failureSignals && {
          failure_signal_context_version: 1,
          failure_trigger_aborted: failureSignals.trigger_aborted,
          failure_stop_aborted: failureSignals.stop_aborted,
          failure_matches_trigger_reason: failureSignals.matches_trigger_reason,
          failure_matches_stop_reason: failureSignals.matches_stop_reason,
          finalization_trigger_aborted: snapshot.canceled === true,
        }),
        outcome,
        // Never relabel an authoritative error as the local stop's finish.
        finish_reason:
          terminalFinishReason ??
          (localStop && outcome === "aborted"
            ? LOCAL_CONNECTION_LOST_FINISH_REASON
            : "unknown"),
        step_limit_reached: terminalStepLimitReached ?? null,
        ...(outcome === "aborted" && {
          abort_source:
            terminalAbortSource ??
            (kind === "usage_limit"
              ? "budget_exhausted"
              : kind === "elapsed_timeout"
                ? "elapsed_timeout"
                : // Match resolveAgentAbortSource for a local stop.
                  localStop && !snapshot.canceled
                  ? "unknown"
                  : "request_cancel"),
        }),
        $process_person_profile: false,
      };
      for (const event of [
        "hackerai-agent_run",
        "hackerai-usage_cost",
      ] as const) {
        once(
          event,
          () =>
            context.posthog!.capture({
              distinctId: context.userId,
              uuid: agentRunEventUuid(context.runId, event),
              event,
              properties: {
                ...properties,
                ...(event === "hackerai-agent_run" &&
                  localStopAnalyticsProperties(localStop)),
                ...(event === "hackerai-usage_cost"
                  ? {
                      ...snapshot.usageMeasurement,
                      // Known work only; unreported calls keep it a lower bound.
                      known_incurred_cost_lower_bound_dollars:
                        knownIncurredCostLowerBound({
                          knownIncurredCostDollars:
                            snapshot.usageMeasurement
                              ?.usage_known_incurred_cost_dollars,
                          trackedTriggerCostDollars:
                            snapshot.usageMeasurement
                              ?.usage_trigger_run_cost_dollars,
                          latestTriggerCostDollars: snapshot.triggerCostDollars,
                        }),
                      // This is a coverage record, not a billable/full-cost estimate.
                      cost_accounting_status: "incomplete",
                      usage_settlement_status: "unknown",
                      cost_dollars: null,
                      model_cost_dollars: null,
                      non_model_cost_dollars: null,
                      known_trigger_cost_dollars: knownAmount(
                        snapshot.triggerCostDollars,
                      ),
                      observed_accumulated_cost_dollars: knownAmount(
                        snapshot.observedAccumulatedCostDollars,
                      ),
                      trigger_cost_is_final: false,
                    }
                  : {}),
                trigger_usage_duration_ms: knownAmount(
                  snapshot.triggerDurationMs,
                ),
              },
            }),
          undefined,
        );
      }
    },
  };
}
