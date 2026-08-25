import { describe, expect, it } from "@jest/globals";
import {
  buildAgentPerformanceDiagnostics,
  SLOW_AGENT_FIRST_OUTPUT_THRESHOLD_MS,
  SLOW_AGENT_RUNTIME_THRESHOLD_MS,
} from "../agent-performance-diagnostics";

describe("buildAgentPerformanceDiagnostics", () => {
  it("separates provider first-chunk latency from pre-model startup", () => {
    expect(
      buildAgentPerformanceDiagnostics({
        triggerUsageDurationMs: 25_000,
        routePreTriggerDurationMs: 100,
        triggerTaskStartLatencyMs: 400,
        taskToFirstModelStartMs: 1_000,
        requestToFirstModelStartMs: 1_500,
        requestToFirstModelChunkMs: 18_000,
        activeModelStreamDurationMs: 18_000,
        activeTerminalWaitDurationMs: 2_000,
        approvalWaitDurationMs: 0,
        activeSandboxRecoveryDurationMs: 0,
      }),
    ).toEqual({
      version: 1,
      initialDelayPhase: "provider_first_chunk",
      initialDelayPhaseDurationMs: 16_500,
      providerFirstChunkDurationMs: 16_500,
      primaryRuntimePhase: "model_stream",
      primaryRuntimePhaseDurationMs: 18_000,
      accountedRuntimeDurationMs: 21_000,
      unattributedRuntimeDurationMs: 4_000,
      firstOutputSlow: true,
      runtimeSlow: false,
    });
  });

  it("classifies terminal-heavy long runs and exposes residual time", () => {
    expect(
      buildAgentPerformanceDiagnostics({
        triggerUsageDurationMs: SLOW_AGENT_RUNTIME_THRESHOLD_MS,
        taskToFirstModelStartMs: 2_000,
        requestToFirstModelStartMs: 2_500,
        requestToFirstModelChunkMs: 3_000,
        activeModelStreamDurationMs: 30_000,
        activeTerminalWaitDurationMs: 70_000,
        approvalWaitDurationMs: 5_000,
        activeSandboxRecoveryDurationMs: 1_000,
      }),
    ).toEqual(
      expect.objectContaining({
        initialDelayPhase: "pre_model",
        providerFirstChunkDurationMs: 500,
        primaryRuntimePhase: "terminal_wait",
        primaryRuntimePhaseDurationMs: 70_000,
        accountedRuntimeDurationMs: 108_000,
        unattributedRuntimeDurationMs: 12_000,
        firstOutputSlow: false,
        runtimeSlow: true,
      }),
    );
  });

  it("returns undefined without any timing measurements", () => {
    expect(buildAgentPerformanceDiagnostics({})).toBeUndefined();
  });

  it("preserves a zero-duration measured run", () => {
    expect(
      buildAgentPerformanceDiagnostics({
        triggerUsageDurationMs: 0,
        requestToFirstModelChunkMs: 0,
      }),
    ).toEqual(
      expect.objectContaining({
        initialDelayPhase: "none",
        primaryRuntimePhase: "none",
        firstOutputSlow: false,
        runtimeSlow: false,
      }),
    );
  });

  it("marks the exact first-output threshold as slow", () => {
    expect(
      buildAgentPerformanceDiagnostics({
        requestToFirstModelChunkMs: SLOW_AGENT_FIRST_OUTPUT_THRESHOLD_MS,
      }),
    ).toEqual(expect.objectContaining({ firstOutputSlow: true }));
  });
});
