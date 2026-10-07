import type { ProviderModelHistoryEntry } from "@/lib/ai/provider-model-history";

const MAX_RETAINED_CALLS = 16;

type Call = {
  entry: ProviderModelHistoryEntry;
  callIndex: number;
  generationAttempt: number;
};

const identifier = (value: string | undefined) =>
  value && value.length <= 512 ? value : undefined;

/** Retain a bounded tail of actual calls and emit one content-free run record. */
export function createSubagentProviderHistory(
  context: {
    subagent_id: string;
    parent_trigger_run_id: string;
    trigger_run_id: string;
    user_id: string;
    environment: string;
  },
  emit: (event: Record<string, unknown>) => void,
) {
  const calls: Call[] = [];
  let callCount = 0;
  let flushed = false;
  return {
    record(entry: ProviderModelHistoryEntry, generationAttempt: number) {
      if (flushed) return;
      callCount += 1;
      calls.push({ entry, callIndex: callCount, generationAttempt });
      if (calls.length > MAX_RETAINED_CALLS) calls.shift();
    },
    flush(
      aborted: boolean,
      reason: "run_exit" | "cancellation_hook" = "run_exit",
    ) {
      if (flushed) return;
      flushed = true;
      if (callCount === 0) return;
      try {
        emit({
          ...context,
          timestamp: new Date().toISOString(),
          level: "info",
          event: "subagent_provider_history",
          service: "hackerai-subagent",
          request_id: context.trigger_run_id,
          flush_reason: reason,
          provider_call_count: callCount,
          omitted_provider_call_count: callCount - calls.length,
          provider_calls: calls.map(
            ({ entry, callIndex, generationAttempt }) => ({
              call_index: callIndex,
              generation_attempt: generationAttempt,
              generation_step: entry.generation_step,
              timestamp: entry.timestamp,
              configured: identifier(entry.configured),
              requested: identifier(entry.requested),
              provider: identifier(entry.provider),
              actual: identifier(entry.actual),
              upstream_provider: identifier(entry.upstream_provider),
              response_id: identifier(entry.response_id),
              openrouter_generation_id: identifier(
                entry.openrouter_generation_id,
              ),
              openrouter_request_id: identifier(entry.openrouter_request_id),
              openrouter_attempts: entry.openrouter_attempts
                ?.slice(0, 8)
                .map(({ provider, model, status, selected }) => ({
                  provider: identifier(provider),
                  model: identifier(model),
                  status,
                  selected,
                })),
              outcome:
                entry.outcome === "pending"
                  ? aborted
                    ? "aborted"
                    : "incomplete"
                  : entry.outcome,
              finish_reason: identifier(entry.finish_reason),
              duration_ms:
                entry.duration_ms ??
                Math.max(0, Date.now() - Date.parse(entry.timestamp)),
            }),
          ),
        });
      } catch {
        // A telemetry failure must not change task completion or cleanup.
      } finally {
        calls.length = 0;
      }
    },
  };
}
