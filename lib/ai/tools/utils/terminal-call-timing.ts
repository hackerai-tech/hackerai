import type { ToolExecutionOptions } from "ai";
import type { ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { sampleDiagnosticOperation } from "@/lib/analytics/diagnostic-sampling";

const SLOW_TERMINAL_CALL_MS = 30_000;

type TerminalInput = {
  timeout?: number;
  action?: "send" | "wait" | "view" | "kill";
};

/** Measures the tool call, including approval/setup/recovery, not process lifetime. */
export function withTerminalCallTiming<
  Input extends TerminalInput,
  Output extends { result: Record<string, unknown> },
>(
  context: Pick<ToolContext, "chatId" | "userID" | "triggerRunId">,
  toolName: "run_terminal_cmd" | "interact_terminal_session",
  execute: (input: Input, options: ToolExecutionOptions) => Promise<Output>,
) {
  return async (
    input: Input,
    options: ToolExecutionOptions,
  ): Promise<Output> => {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const timing = () => ({
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Math.max(0, Math.round(performance.now() - start)),
    });
    const report = (
      callTiming: ReturnType<typeof timing>,
      outcome: "returned" | "threw",
      result?: Record<string, unknown>,
    ) => {
      try {
        const exitCode = result?.exitCode;
        const nestedExitCode = (
          result?.exited as { exitCode?: unknown } | undefined
        )?.exitCode;
        const diagnostic =
          outcome === "threw" ||
          options.abortSignal?.aborted === true ||
          Boolean(result?.error) ||
          result?.success === false ||
          result?.waitExpired === true ||
          result?.timedOut === true ||
          result?.recovered === true ||
          result?.recordPersistenceFailed === true ||
          result?.status === "unknown" ||
          !(
            exitCode === 0 ||
            nestedExitCode === 0 ||
            (typeof result?.session === "string" &&
              result.session.length > 0 &&
              result.exited === undefined &&
              exitCode == null)
          ) ||
          (typeof exitCode === "number" && exitCode !== 0) ||
          (typeof nestedExitCode === "number" && nestedExitCode !== 0) ||
          callTiming.elapsedMs >= SLOW_TERMINAL_CALL_MS;
        if (
          !diagnostic &&
          !sampleDiagnosticOperation(
            JSON.stringify([
              context.triggerRunId ?? context.chatId,
              options.toolCallId,
            ]),
          )
        )
          return;
        // Never include the command, brief, stdin, output, paths, or error text.
        phLogger.info("terminal_call_finished", {
          event: "terminal_call_finished",
          service: context.triggerRunId ? "agent-long" : "chat-handler",
          chat_id: context.chatId,
          user_id: context.userID,
          trigger_run_id: context.triggerRunId ?? null,
          tool_call_id: options.toolCallId,
          tool_name: toolName,
          action: input.action ?? "exec",
          requested_wait_seconds: input.timeout ?? null,
          tool_elapsed_ms: callTiming.elapsedMs,
          outcome,
          telemetry_version: 2,
          telemetry_sample_rate: diagnostic ? 1 : 0.1,
          telemetry_selection: diagnostic ? "diagnostic" : "sampled",
          result_error: Boolean(result?.error),
          recovered: result?.recovered === true,
          record_persistence_failed: result?.recordPersistenceFailed === true,
          timed_out: result?.timedOut === true,
          signal_aborted: options.abortSignal?.aborted ?? false,
          wait_expired: result?.waitExpired === true,
          session_returned: typeof result?.session === "string",
          exit_code:
            typeof result?.exitCode === "number" &&
            Number.isFinite(result.exitCode)
              ? result.exitCode
              : null,
          output_bytes:
            typeof result?.output === "string"
              ? Buffer.byteLength(result.output)
              : 0,
        });
      } catch {
        // Diagnostics cannot change execution, cancellation, or the result.
      }
    };
    let output: Output;
    try {
      output = await execute(input, options);
    } catch (error) {
      report(timing(), "threw");
      throw error;
    }
    const callTiming = timing();
    report(callTiming, "returned", output.result);
    return { ...output, result: { ...output.result, callTiming } };
  };
}
