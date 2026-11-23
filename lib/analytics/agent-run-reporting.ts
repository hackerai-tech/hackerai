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
  localRecoveryAnalyticsProperties,
  localStopAnalyticsProperties,
  type LocalRunRecoverySummary,
} from "@/lib/chat/local-connection-stop";
import { resumeAnalyticsProperties } from "@/lib/chat/manual-agent-resume";
import { BROWSER_HANDOFF_ABANDONED_FINISH_REASON } from "@/lib/ai/browser-handoff/constants";

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

const TERMINAL_FINISH_REASONS = [
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
  LOCAL_CONNECTION_LOST_FINISH_REASON,
  BROWSER_HANDOFF_ABANDONED_FINISH_REASON,
];
const TERMINAL_ABORT_SOURCES = [
  "budget_exhausted",
  "agent_spend_cap",
  "elapsed_timeout",
  "user_wait_timeout",
  "user_wait_failed",
  "approval_timeout",
  "browser_handoff_abandoned",
  "user_stop",
  "request_cancel",
  "unknown",
];
/** Retry legs started by the Agent orchestrator after its first model stream. */
const MODEL_RECOVERY_REASONS = [
  "provider_api_error",
  "vision_api_error",
  "abliteration_api_error",
  "content_filter",
  "provider_disconnect_continuation",
  "empty_answer",
  "empty_answer_continuation",
  "vision_summary_recovery",
  "image_tool_result_rejection",
  "assistant_content_loop",
  "doom_loop",
  "interrupted_tool_input",
  "non_durable_output_limit",
  "reasoning_only_provider_error",
  "incomplete_stream",
  "agent_finish_empty_after_tools",
  "agent_finish_announced_next_action",
];
const PROVIDER_FAILURE_CATEGORIES = [
  "rate_limited",
  "content_blocked",
  "provider_5xx",
  "provider_4xx",
  "stream_terminated",
  "timeout",
  "unknown",
];
// Recovery is bounded by the orchestrator; this cap only bounds the record.
const MAX_RECORDED_RECOVERIES = 4;
// Registry keys and provider slugs only; anything else is reported as unknown.
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

const allowed = (value: unknown, values: readonly string[]) =>
  typeof value === "string" && values.includes(value) ? value : undefined;
const modelIdentifier = (value: unknown) =>
  typeof value === "string" && MODEL_IDENTIFIER.test(value) ? value : undefined;
const httpStatus = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 100 &&
  value <= 599
    ? value
    : undefined;

type ModelRecoveryHistory = Readonly<{
  attempts: number;
  models: readonly string[];
  reasons: readonly string[];
  initialFailure?: Readonly<{
    category: string;
    model?: string;
    statusCode?: number;
  }>;
}>;
// Only histories built by a reporter produce properties, never caller objects.
const modelRecoveryHistories = new WeakSet<object>();

/** Closed fields describing which failure started recovery and where it went. */
export function modelRecoveryAnalyticsProperties(
  history: unknown,
  outcome: unknown,
) {
  if (
    history === null ||
    typeof history !== "object" ||
    !modelRecoveryHistories.has(history)
  )
    return undefined;
  const { attempts, models, reasons, initialFailure } =
    history as ModelRecoveryHistory;
  return {
    model_recovery_version: 1,
    model_recovery_attempts: attempts,
    model_recovery_models: [...models],
    model_recovery_reasons: [...reasons],
    model_recovery_succeeded: outcome === "success",
    ...(initialFailure && {
      initial_provider_failure_category: initialFailure.category,
      ...(initialFailure.model && {
        initial_provider_failure_model: initialFailure.model,
      }),
      ...(initialFailure.statusCode !== undefined && {
        initial_provider_failure_status_code: initialFailure.statusCode,
      }),
    }),
  } as const;
}

export type AgentRunMetadataValue = string | number | boolean;

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
  /** The saved manual-resume stop this user-initiated run resumes. */
  resumeFromFinishReason?: string;
  getFailureSignalContext?: (
    error: unknown,
  ) => FailureSignalContext | undefined;
  /**
   * Trigger run metadata sink for closed agent* outcome fields. Runtime
   * COMPLETED only means orchestration settled; these describe the Agent.
   */
  setRunMetadata?: (key: string, value: AgentRunMetadataValue) => void;
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
  let readLocalRecovery:
    (() => LocalRunRecoverySummary | undefined) | undefined;
  const localRecoverySummary = () => {
    try {
      return readLocalRecovery?.();
    } catch {
      return undefined;
    }
  };
  // Run-scoped: stream state resets before each retry and must not erase
  // which provider failure started recovery.
  let recoveryAttempts = 0;
  const recoveryModels: string[] = [];
  const recoveryReasons: string[] = [];
  let initialProviderFailure: ModelRecoveryHistory["initialFailure"];

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

  function setMetadata(
    entries: Record<string, AgentRunMetadataValue | undefined>,
  ) {
    if (!context.setRunMetadata) return;
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) continue;
      try {
        context.setRunMetadata(key, value);
      } catch {
        // Metadata is diagnostic; it cannot change the run's outcome.
      }
    }
  }

  function recoveryHistory(): ModelRecoveryHistory | undefined {
    if (recoveryAttempts === 0) return undefined;
    const history = Object.freeze({
      attempts: recoveryAttempts,
      models: Object.freeze([...recoveryModels]),
      reasons: Object.freeze([...recoveryReasons]),
      initialFailure: initialProviderFailure,
    });
    modelRecoveryHistories.add(history);
    return history;
  }

  function setTerminalMetadata(
    source: "completion" | "run_finally",
    outcome: "success" | "error" | "aborted",
    finishReason: string | undefined,
    abortSource: string | undefined,
  ) {
    setMetadata({
      agentOutcome: outcome,
      agentOutcomeSource: source,
      agentFinishReason: finishReason,
      agentAbortSource: outcome === "aborted" ? abortSource : undefined,
      agentLocalStopReason: getLocalStopDiagnostic(localStop)?.reason,
      agentRecoverySucceeded:
        recoveryAttempts > 0 ? outcome === "success" : undefined,
    });
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
    /** Read when the run reports; recovered outages never stop a run. */
    setLocalRecoverySource(read: () => LocalRunRecoverySummary | undefined) {
      readLocalRecovery = read;
    },
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
    /**
     * Call once per retry leg, before stream state is reset. `failure` is read
     * only through its category/model/statusCode fields.
     */
    recordModelRecovery(attempt: {
      reason: string;
      retryModel: string;
      failure?: unknown;
    }) {
      // A retry cannot explain a terminal outcome already recorded.
      if (terminalOutcome) return;
      recoveryAttempts += 1;
      const reason = allowed(attempt.reason, MODEL_RECOVERY_REASONS) ?? "other";
      const retryModel = modelIdentifier(attempt.retryModel) ?? "unknown";
      if (recoveryModels.length < MAX_RECORDED_RECOVERIES) {
        recoveryModels.push(retryModel);
        recoveryReasons.push(reason);
      }
      if (!initialProviderFailure && attempt.failure) {
        const category = allowed(
          field(attempt.failure, "category"),
          PROVIDER_FAILURE_CATEGORIES,
        );
        if (category)
          initialProviderFailure = Object.freeze({
            category,
            model: modelIdentifier(field(attempt.failure, "model")),
            statusCode: httpStatus(field(attempt.failure, "statusCode")),
          });
      }
      setMetadata({
        agentRecoveryAttempts: recoveryAttempts,
        agentRecoveryModel: retryModel,
        agentRecoveryReason: reason,
        agentProviderFailureCategory: initialProviderFailure?.category,
        agentProviderFailureModel: initialProviderFailure?.model,
        agentProviderFailureStatusCode: initialProviderFailure?.statusCode,
      });
    },
    captureTerminal<T>(capture: (args: T) => void, args: T) {
      const outcome = field(args, "outcome");
      if (
        outcome === "success" ||
        outcome === "error" ||
        outcome === "aborted"
      ) {
        const firstOutcome = terminalOutcome === undefined;
        terminalOutcome ??= outcome;
        // A failed enqueue must retain observed stream metadata, without
        // accepting arbitrary strings or inventing a natural completion.
        const finishReason = allowed(
          field(args, "finishReason"),
          TERMINAL_FINISH_REASONS,
        );
        if (finishReason) terminalFinishReason ??= finishReason;
        const stepLimitReached = field(
          field(args, "stepLimitTelemetry"),
          "stepLimitReached",
        );
        if (typeof stepLimitReached === "boolean")
          terminalStepLimitReached ??= stepLimitReached;
        const abortSource = allowed(
          field(args, "abortSource"),
          TERMINAL_ABORT_SOURCES,
        );
        if (abortSource) terminalAbortSource ??= abortSource;
        if (firstOutcome)
          setTerminalMetadata(
            "completion",
            terminalOutcome,
            terminalFinishReason,
            terminalAbortSource,
          );
      }
      const modelRecoveryHistory = recoveryHistory();
      const localRecovery = localRecoverySummary();
      const resumeFromFinishReason = context.resumeFromFinishReason;
      once(
        "hackerai-agent_run",
        capture,
        agentModelContextVariant ||
          localStop ||
          modelRecoveryHistory ||
          localRecovery ||
          resumeFromFinishReason
          ? {
              ...args,
              ...(agentModelContextVariant && {
                agentModelContextVariant,
                agentModelContextFlag,
              }),
              ...(localStop && { localConnectionLostError: localStop }),
              ...(modelRecoveryHistory && { modelRecoveryHistory }),
              ...(localRecovery && { localRecoverySummary: localRecovery }),
              ...(resumeFromFinishReason && { resumeFromFinishReason }),
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
      // A first local stop ends the run like a cancellation, not a failure.
      const kind =
        failure?.kind ??
        (snapshot.canceled || localStop ? "canceled" : "error");
      const outcome =
        terminalOutcome ?? (kind === "error" ? "error" : "aborted");
      // Never relabel an authoritative error as the local stop's finish.
      const finishReason =
        terminalFinishReason ??
        (localStop && outcome === "aborted"
          ? LOCAL_CONNECTION_LOST_FINISH_REASON
          : "unknown");
      const abortSource =
        outcome === "aborted"
          ? (terminalAbortSource ??
            (kind === "usage_limit"
              ? "budget_exhausted"
              : kind === "elapsed_timeout"
                ? "elapsed_timeout"
                : // Match resolveAgentAbortSource for a local stop.
                  localStop && !snapshot.canceled
                  ? "unknown"
                  : "request_cancel"))
          : undefined;
      if (!terminalOutcome)
        setTerminalMetadata("run_finally", outcome, finishReason, abortSource);
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
        finish_reason: finishReason,
        step_limit_reached: terminalStepLimitReached ?? null,
        ...(abortSource && { abort_source: abortSource }),
        $process_person_profile: false,
      };
      const modelRecoveryProperties = modelRecoveryAnalyticsProperties(
        recoveryHistory(),
        outcome,
      );
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
                ...(event === "hackerai-agent_run" && {
                  ...localStopAnalyticsProperties(localStop),
                  ...localRecoveryAnalyticsProperties(
                    localRecoverySummary(),
                    localStop,
                  ),
                  ...resumeAnalyticsProperties(context.resumeFromFinishReason),
                  ...modelRecoveryProperties,
                }),
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
