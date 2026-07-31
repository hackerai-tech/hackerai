import { phLogger } from "@/lib/posthog/server";
import type {
  ChatMode,
  SandboxResourceMetrics,
  SandboxResourceMetricsObserver,
  SubscriptionTier,
} from "@/types";

export const E2B_CPU_SATURATION_THRESHOLD_PCT = 99;
export const E2B_MEMORY_PRESSURE_THRESHOLD_PCT = 90;
export const E2B_RESOURCE_PRESSURE_EVENT_VERSION = 2;
const E2B_FAILURE_RECOVERY_EVENT_VERSION = 1;

const roundPercentage = (value: number): number =>
  Math.round(value * 100) / 100;

type ResourcePressureType = "none" | "cpu" | "memory" | "both" | "unknown";

function classifyResourcePressure(
  metrics: SandboxResourceMetrics | null,
): ResourcePressureType {
  if (!metrics) return "unknown";

  const cpuIsPressured =
    Number.isFinite(metrics.cpuPct) &&
    metrics.cpuPct >= E2B_CPU_SATURATION_THRESHOLD_PCT;
  const memoryIsPressured =
    Number.isFinite(metrics.memPct) &&
    metrics.memPct >= E2B_MEMORY_PRESSURE_THRESHOLD_PCT;

  if (cpuIsPressured && memoryIsPressured) return "both";
  if (cpuIsPressured) return "cpu";
  if (memoryIsPressured) return "memory";
  return "none";
}

function metricProperties(metrics: SandboxResourceMetrics | null) {
  if (!metrics) {
    return {
      metrics_available: false,
    };
  }

  return {
    metrics_available: true,
    cpu_used_pct: roundPercentage(metrics.cpuPct),
    memory_used_pct: roundPercentage(metrics.memPct),
    disk_used_pct: roundPercentage(metrics.diskPct),
  };
}

/**
 * Tracks independent rising edges into CPU and memory pressure for one request.
 *
 * Sustained pressure for either resource emits once. Each resource rearms
 * independently after recovering below its threshold.
 */
export function createE2BResourcePressureObserver(args: {
  userId: string;
  chatId: string;
  mode: ChatMode;
  subscription?: SubscriptionTier;
  triggerRunId?: string;
}): SandboxResourceMetricsObserver {
  let cpuWasPressured = false;
  let memoryWasPressured = false;

  const commonProperties = {
    userId: args.userId,
    chat_id: args.chatId,
    mode: args.mode,
    subscription_tier: args.subscription ?? "unknown",
    sandbox_type: "e2b",
    ...(args.triggerRunId && { trigger_run_id: args.triggerRunId }),
    cpu_saturation_threshold_pct: E2B_CPU_SATURATION_THRESHOLD_PCT,
    memory_pressure_threshold_pct: E2B_MEMORY_PRESSURE_THRESHOLD_PCT,
    resource_pressure_event_version: E2B_RESOURCE_PRESSURE_EVENT_VERSION,
  };

  return (observation) => {
    if (observation.kind === "recovery") {
      phLogger.event("e2b_sandbox_recovery_observed", {
        ...commonProperties,
        recovery_source: observation.source,
        recovery_outcome: observation.outcome,
        initial_failure_reason: observation.initialFailureReason,
        recovery_event_version: E2B_FAILURE_RECOVERY_EVENT_VERSION,
        ...(observation.finalFailureReason && {
          final_failure_reason: observation.finalFailureReason,
        }),
      });
      return;
    }

    if (observation.kind === "timeout_recovery") {
      phLogger.event("e2b_terminal_timeout_recovery_observed", {
        ...commonProperties,
        recovery_source: observation.source,
        recovery_outcome: observation.outcome,
        recovery_event_version: E2B_FAILURE_RECOVERY_EVENT_VERSION,
      });
      return;
    }

    const pressureType = classifyResourcePressure(observation.metrics);

    if (observation.kind === "failure") {
      phLogger.event("e2b_sandbox_resource_failure_observed", {
        ...commonProperties,
        ...metricProperties(observation.metrics),
        pressure_type: pressureType,
        failure_type: observation.failureType,
        observation_source: observation.source,
        ...(observation.failureReason && {
          failure_reason: observation.failureReason,
        }),
        ...(observation.readinessStage && {
          readiness_stage: observation.readinessStage,
        }),
        ...(observation.lifecycleState && {
          sandbox_lifecycle_state: observation.lifecycleState,
        }),
        ...(observation.timeoutSeconds !== undefined && {
          timeout_seconds: observation.timeoutSeconds,
        }),
        ...(observation.terminalTimeoutOutcome && {
          terminal_timeout_outcome: observation.terminalTimeoutOutcome,
        }),
        ...(observation.terminationAttempted !== undefined && {
          termination_attempted: observation.terminationAttempted,
        }),
        ...(observation.terminationSucceeded !== undefined && {
          termination_succeeded: observation.terminationSucceeded,
        }),
        ...(observation.sessionReturned !== undefined && {
          session_returned: observation.sessionReturned,
        }),
        ...(observation.isBackground !== undefined && {
          is_background: observation.isBackground,
        }),
      });
      return;
    }

    const { metrics } = observation;
    const cpuIsPressured =
      Number.isFinite(metrics.cpuPct) &&
      metrics.cpuPct >= E2B_CPU_SATURATION_THRESHOLD_PCT;
    const memoryIsPressured =
      Number.isFinite(metrics.memPct) &&
      metrics.memPct >= E2B_MEMORY_PRESSURE_THRESHOLD_PCT;
    const cpuEnteredPressure = cpuIsPressured && !cpuWasPressured;
    const memoryEnteredPressure = memoryIsPressured && !memoryWasPressured;

    cpuWasPressured = cpuIsPressured;
    memoryWasPressured = memoryIsPressured;

    if (!cpuEnteredPressure && !memoryEnteredPressure) return;

    const newlyPressuredResource =
      cpuEnteredPressure && memoryEnteredPressure
        ? "both"
        : cpuEnteredPressure
          ? "cpu"
          : "memory";

    phLogger.event("e2b_sandbox_resource_pressure_observed", {
      ...commonProperties,
      ...metricProperties(metrics),
      pressure_type: pressureType,
      newly_pressured_resource: newlyPressuredResource,
      observation_source: observation.source,
    });
  };
}
