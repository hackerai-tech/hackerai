import { extractErrorDetails } from "@/lib/utils/error-utils";

export type SubagentTerminalOutput = {
  subagentId: string;
  status: "completed" | "failed" | "canceled" | "timed_out";
};

export type HandledRateLimitFinishInput = {
  subagentId: string;
  triggerRunId: string;
  status: "failed";
  summary: string;
  failureCode: string;
  failureReason?: string;
  costDollars: number;
  stepCount: number;
};

type FinishOutcome = "updated" | "stale" | "not_found";

type FinalizationTelemetry = {
  environment: string;
  userId: string;
  subagentId: string;
  parentTriggerRunId: string;
  triggerRunId: string;
};

export type HandledRateLimitFinalizationDependencies = {
  finishSubagent: (
    input: HandledRateLimitFinishInput,
  ) => Promise<FinishOutcome>;
  loadPersistedTerminalOutput: (
    subagentId: string,
  ) => Promise<SubagentTerminalOutput | null>;
  captureTerminalOutcome: () => void;
  logError: (message: string, fields: Record<string, unknown>) => void;
  recordFinalizationFailureMetadata: () => void;
};

export const finalizeHandledSubagentRateLimit = async (
  finishInput: HandledRateLimitFinishInput,
  telemetry: FinalizationTelemetry,
  dependencies: HandledRateLimitFinalizationDependencies,
): Promise<{ output: SubagentTerminalOutput; updated: boolean }> => {
  let finishError: unknown;
  const finishOutcome = await dependencies
    .finishSubagent(finishInput)
    .catch((error: unknown) => {
      finishError = error;
      return null;
    });

  if (finishOutcome === "updated") {
    dependencies.captureTerminalOutcome();
    return {
      output: { subagentId: finishInput.subagentId, status: "failed" },
      updated: true,
    };
  }

  const persistedOutput = await dependencies
    .loadPersistedTerminalOutput(finishInput.subagentId)
    .catch(() => null);
  if (persistedOutput) {
    return { output: persistedOutput, updated: false };
  }

  const finalizationError =
    finishError ??
    new Error(
      `Subagent rate-limit finalization failed: ${finishOutcome ?? "unknown"}`,
    );
  const diagnostics = extractErrorDetails(finalizationError);
  dependencies.logError("[subagent] rate-limit finalization failed", {
    event: "subagent_rate_limit_finalization_failed",
    service: "hackerai-subagent",
    environment: telemetry.environment,
    user_id: telemetry.userId,
    subagent_id: telemetry.subagentId,
    parent_trigger_run_id: telemetry.parentTriggerRunId,
    trigger_run_id: telemetry.triggerRunId,
    finish_outcome: finishOutcome ?? "error",
    error_name: diagnostics.errorName,
    error_message: diagnostics.errorMessage,
  });
  dependencies.recordFinalizationFailureMetadata();
  throw finalizationError;
};
