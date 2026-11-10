import type { ToolExecutionOptions } from "ai";
import type { ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { sampleDiagnosticOperation } from "@/lib/analytics/diagnostic-sampling";
import { detectAgentBrowserUsage } from "@/lib/utils/agent-browser-command";
import {
  getAgentBrowserFailureEligibility,
  getAgentBrowserOutputDiagnostics,
} from "./agent-browser-open-failure";

const SLOW_TERMINAL_CALL_MS = 30_000;

type TerminalInput = {
  timeout?: number;
  action?: "send" | "wait" | "view" | "kill";
  command?: string;
  interactive?: boolean;
  is_background?: boolean;
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
        // Intent is a property of this returned tool call, not proof that every
        // CLI child ran or that its exit determined a compound shell's exit.
        // Never inspect interaction stdin or launch another command.
        const usage =
          toolName === "run_terminal_cmd" && typeof input.command === "string"
            ? detectAgentBrowserUsage(input.command)
            : null;
        const browserIntent = usage?.actions.includes("open")
          ? "open"
          : usage?.actions.includes("option")
            ? "option"
            : null;
        const browserOutput =
          browserIntent && result
            ? getAgentBrowserOutputDiagnostics(result)
            : null;
        const browserContext = browserIntent
          ? {
              browser_result_context_version: 1,
              browser_intent: browserIntent,
              browser_detected_invocation_count: Math.min(
                usage!.invocationCount,
                16,
              ),
              browser_interactive: input.interactive === true,
              browser_background: input.is_background === true,
              browser_approval_denied: Boolean(result?.approvalDenied),
              browser_process_started:
                result?.processStarted === true
                  ? "true"
                  : result?.processStarted === false
                    ? "false"
                    : "unavailable",
              browser_execution_outcome:
                result?.executionOutcome === undefined
                  ? "absent"
                  : result.executionOutcome === "unknown"
                    ? "unknown"
                    : "other",
              browser_failure_capture_eligibility: result
                ? getAgentBrowserFailureEligibility({
                    result,
                    interactive: input.interactive,
                    isBackground: input.is_background === true,
                    aborted: options.abortSignal?.aborted === true,
                  })
                : "result_unavailable",
              ...(browserOutput && {
                browser_public_output_hint: browserOutput.public_output_hint,
                browser_public_json_error_state:
                  browserOutput.public_json_error_state,
                browser_json_candidate_limit_reached:
                  browserOutput.json_candidate_limit_reached,
                browser_output_sample_present:
                  browserOutput.output_sample_present,
                browser_output_sample_truncated:
                  browserOutput.output_sample_truncated,
              }),
            }
          : {};
        const exitCode = result?.exitCode;
        const nestedExitCode = (
          result?.exited as { exitCode?: unknown } | undefined
        )?.exitCode;
        const diagnostic =
          browserIntent !== null ||
          outcome === "threw" ||
          options.abortSignal?.aborted === true ||
          Boolean(result?.error) ||
          result?.success === false ||
          result?.waitExpired === true ||
          result?.timedOut === true ||
          result?.recovered === true ||
          result?.recordPersistenceFailed === true ||
          result?.recordPersistenceStatus === "pending" ||
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
        // Correlate only the server-returned short PTY ID, never a requested
        // session or arbitrary result text. Keep the run/chat IDs in the join.
        const returnedSession = result?.session;
        const terminalSessionId =
          typeof returnedSession === "string" &&
          returnedSession.length === 8 &&
          /^[a-f0-9]{8}$/.test(returnedSession)
            ? returnedSession
            : null;
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
          telemetry_version: 3,
          terminal_session_id: terminalSessionId,
          telemetry_sample_rate: diagnostic ? 1 : 0.1,
          telemetry_selection: diagnostic ? "diagnostic" : "sampled",
          result_error: Boolean(result?.error),
          recovered: result?.recovered === true,
          record_persistence_failed: result?.recordPersistenceFailed === true,
          record_persistence_status:
            result?.recordPersistenceStatus === "pending" ||
            result?.recordPersistenceStatus === "saved" ||
            result?.recordPersistenceStatus === "failed"
              ? result.recordPersistenceStatus
              : "unknown",
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
          ...browserContext,
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
