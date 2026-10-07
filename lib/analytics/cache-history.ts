import { createHash } from "node:crypto";

/** Hash only a random run identifier, never prompts or history contents. */
export function sampleCacheHistoryStart(runId: string): boolean {
  return (
    createHash("sha256").update(runId).digest().readUInt32BE(0) <
    0x100000000 / 10
  );
}

export type CacheHistoryTelemetry = {
  runId: string;
  eligible: boolean;
  assignment: "treatment" | "control" | "unavailable" | "ineligible";
  model: string;
  startedAt: number;
  sampled: boolean;
  attempts: number;
  exposures: number;
  restores: number;
  load:
    | "not_attempted"
    | "missing"
    | "invalid"
    | "invalidated"
    | "restored"
    | "timeout"
    | "error";
  save:
    | "not_attempted"
    | "pending"
    | "saved"
    | "rejected"
    | "too_large"
    | "timeout"
    | "error";
  fallback?:
    "initialization" | "route_or_content" | "prepare_error" | "response_model";
};

/** Bounded enums/counters only. Initial assignment survives all provider retries. */
export function cacheHistoryProperties(value?: CacheHistoryTelemetry) {
  if (!value) return {};
  return {
    cache_history_telemetry_version: 1,
    cache_history_run_id: value.runId,
    cache_history_eligible: value.eligible,
    cache_history_assignment: value.assignment,
    cache_history_initial_model: value.model,
    cache_history_started_at: new Date(value.startedAt).toISOString(),
    cache_history_start_sampled: value.sampled,
    cache_history_start_sample_rate: 0.1,
    cache_history_attempts: value.attempts,
    cache_history_exposures: value.exposures,
    cache_history_restores: value.restores,
    cache_history_load_result: value.load,
    cache_history_save_result: value.save,
    cache_history_fallback: value.fallback,
  };
}
