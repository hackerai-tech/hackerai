jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: jest.fn(),
  },
}));

import { phLogger } from "@/lib/posthog/server";
import {
  createE2BResourcePressureObserver,
  E2B_CPU_SATURATION_THRESHOLD_PCT,
  E2B_MEMORY_PRESSURE_THRESHOLD_PCT,
  E2B_RESOURCE_PRESSURE_EVENT_VERSION,
} from "@/lib/analytics/sandbox-resource-pressure";

const mockPhEvent = phLogger.event as jest.MockedFunction<
  typeof phLogger.event
>;

describe("E2B resource pressure telemetry", () => {
  beforeEach(() => {
    mockPhEvent.mockClear();
  });

  const createObserver = () =>
    createE2BResourcePressureObserver({
      userId: "user-1",
      chatId: "chat-1",
      mode: "agent",
      subscription: "pro-plus",
      triggerRunId: "run-123",
    });

  const observeHealth = (
    observer: ReturnType<typeof createObserver>,
    cpuPct: number,
    memPct: number,
    diskPct = 41.234,
  ) =>
    observer({
      kind: "health_sample",
      source: "pre_command_health_check",
      metrics: { cpuPct, memPct, diskPct },
    });

  test("emits a privacy-safe CPU-only pressure event", () => {
    const observe = createObserver();

    observeHealth(observe, 99.876, 72.345);

    expect(mockPhEvent).toHaveBeenCalledWith(
      "e2b_sandbox_resource_pressure_observed",
      {
        userId: "user-1",
        chat_id: "chat-1",
        mode: "agent",
        subscription_tier: "pro-plus",
        sandbox_type: "e2b",
        trigger_run_id: "run-123",
        cpu_used_pct: 99.88,
        memory_used_pct: 72.35,
        disk_used_pct: 41.23,
        metrics_available: true,
        pressure_type: "cpu",
        newly_pressured_resource: "cpu",
        cpu_saturation_threshold_pct: E2B_CPU_SATURATION_THRESHOLD_PCT,
        memory_pressure_threshold_pct: E2B_MEMORY_PRESSURE_THRESHOLD_PCT,
        observation_source: "pre_command_health_check",
        resource_pressure_event_version: E2B_RESOURCE_PRESSURE_EVENT_VERSION,
      },
    );
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("command");
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("error");
  });

  test("emits memory-only and simultaneous pressure classifications", () => {
    const memoryOnly = createObserver();
    observeHealth(memoryOnly, 70, 90);

    expect(mockPhEvent).toHaveBeenLastCalledWith(
      "e2b_sandbox_resource_pressure_observed",
      expect.objectContaining({
        pressure_type: "memory",
        newly_pressured_resource: "memory",
      }),
    );

    mockPhEvent.mockClear();
    const both = createObserver();
    observeHealth(both, 99, 95);

    expect(mockPhEvent).toHaveBeenLastCalledWith(
      "e2b_sandbox_resource_pressure_observed",
      expect.objectContaining({
        pressure_type: "both",
        newly_pressured_resource: "both",
      }),
    );
  });

  test("does not emit while both resources remain below their thresholds", () => {
    const observe = createObserver();

    observeHealth(
      observe,
      E2B_CPU_SATURATION_THRESHOLD_PCT - 0.01,
      E2B_MEMORY_PRESSURE_THRESHOLD_PCT - 0.01,
    );

    expect(mockPhEvent).not.toHaveBeenCalled();
  });

  test("deduplicates and rearms CPU and memory pressure independently", () => {
    const observe = createObserver();

    observeHealth(observe, 100, 70);
    observeHealth(observe, 100, 71);
    observeHealth(observe, 100, 92);
    observeHealth(observe, 80, 92);
    observeHealth(observe, 99, 92);
    observeHealth(observe, 80, 80);
    observeHealth(observe, 80, 90);

    expect(mockPhEvent).toHaveBeenCalledTimes(4);
    expect(
      mockPhEvent.mock.calls.map(([, properties]) => ({
        pressureType: properties.pressure_type,
        newlyPressuredResource: properties.newly_pressured_resource,
      })),
    ).toEqual([
      { pressureType: "cpu", newlyPressuredResource: "cpu" },
      { pressureType: "both", newlyPressuredResource: "memory" },
      { pressureType: "both", newlyPressuredResource: "cpu" },
      { pressureType: "memory", newlyPressuredResource: "memory" },
    ]);
  });

  test("records readiness or command failures with resource context", () => {
    const observe = createObserver();

    observe({
      kind: "failure",
      source: "terminal_command_timeout",
      failureType: "terminal_command_timed_out",
      metrics: { cpuPct: 100, memPct: 95, diskPct: 40 },
      timeoutSeconds: 60,
      terminalTimeoutOutcome: "session_resumable",
      terminationAttempted: false,
      terminationSucceeded: false,
      sessionReturned: true,
      isBackground: false,
    });

    expect(mockPhEvent).toHaveBeenCalledWith(
      "e2b_sandbox_resource_failure_observed",
      expect.objectContaining({
        pressure_type: "both",
        failure_type: "terminal_command_timed_out",
        observation_source: "terminal_command_timeout",
        metrics_available: true,
        cpu_used_pct: 100,
        memory_used_pct: 95,
        timeout_seconds: 60,
        terminal_timeout_outcome: "session_resumable",
        termination_attempted: false,
        termination_succeeded: false,
        session_returned: true,
        is_background: false,
      }),
    );
  });

  test("records failures even when E2B metrics are unavailable", () => {
    const observe = createObserver();

    observe({
      kind: "failure",
      source: "readiness_check_failure",
      failureType: "readiness_check_failed",
      metrics: null,
      failureReason: "permission_denied",
      readinessStage: "reconnect",
      lifecycleState: "running_not_ready",
    });

    expect(mockPhEvent).toHaveBeenCalledWith(
      "e2b_sandbox_resource_failure_observed",
      expect.objectContaining({
        pressure_type: "unknown",
        failure_type: "readiness_check_failed",
        metrics_available: false,
        failure_reason: "permission_denied",
        readiness_stage: "reconnect",
        sandbox_lifecycle_state: "running_not_ready",
      }),
    );
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("cpu_used_pct");
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty(
      "memory_used_pct",
    );
  });

  test("records reconnect outcomes separately from failure observations", () => {
    const observe = createObserver();

    observe({
      kind: "recovery",
      source: "readiness_reconnect",
      outcome: "failed_unavailable",
      initialFailureReason: "connection_error",
      finalFailureReason: "permission_denied",
    });

    expect(mockPhEvent).toHaveBeenCalledWith(
      "e2b_sandbox_recovery_observed",
      expect.objectContaining({
        trigger_run_id: "run-123",
        recovery_source: "readiness_reconnect",
        recovery_outcome: "failed_unavailable",
        initial_failure_reason: "connection_error",
        final_failure_reason: "permission_denied",
        recovery_event_version: 1,
      }),
    );
  });

  test("records the eventual outcome of a resumable timeout", () => {
    const observe = createObserver();

    observe({
      kind: "timeout_recovery",
      source: "terminal_command_timeout",
      outcome: "completed_success",
    });

    expect(mockPhEvent).toHaveBeenCalledWith(
      "e2b_terminal_timeout_recovery_observed",
      expect.objectContaining({
        trigger_run_id: "run-123",
        recovery_source: "terminal_command_timeout",
        recovery_outcome: "completed_success",
        recovery_event_version: 1,
      }),
    );
  });
});
