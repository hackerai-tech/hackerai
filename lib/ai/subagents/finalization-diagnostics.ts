import { getSubagentRecoveryErrorDiagnostics } from "./runtime-recovery";

type FinalizationOperation = "result_submission" | "stream_completion";
type FinalizationOutcome = "updated" | "pending_messages" | "stale";

/** Attribute ambiguous finalization writes without retrying or retaining results. */
export function createSubagentFinalizationDiagnostics(
  context: {
    subagent_id: string;
    parent_trigger_run_id: string;
    trigger_run_id: string;
    environment: string;
  },
  emit: (fields: Record<string, unknown>) => void,
) {
  // Shared by both boundaries for the entire task, including model retries.
  let failuresReported = 0;
  return async (
    operation: FinalizationOperation,
    resultAccepted: boolean,
    markFinalizing: () => Promise<FinalizationOutcome>,
  ): Promise<FinalizationOutcome> => {
    try {
      return await markFinalizing();
    } catch (error) {
      if (failuresReported < 2) {
        failuresReported += 1;
        try {
          const diagnostics = getSubagentRecoveryErrorDiagnostics(error);
          emit({
            ...context,
            event: "subagent_finalization_write_failed",
            service: "hackerai-subagent",
            request_id: context.trigger_run_id,
            finalization_operation: operation,
            // Local acceptance is not proof of a committed terminal result.
            result_accepted: resultAccepted,
            diagnostic_index: failuresReported,
            error_category: diagnostics.category,
            error_name: diagnostics.errorName,
            error_code: diagnostics.errorCode,
            status_code: diagnostics.statusCode,
          });
        } catch {
          // Diagnostics must preserve the original failure and its cause.
        }
      }
      throw error;
    }
  };
}
