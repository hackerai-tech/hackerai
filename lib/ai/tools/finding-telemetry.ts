import type { ToolExecutionOptions } from "ai";
import type { AnySandbox, ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import {
  findingEventProperties,
  type FindingEvent,
} from "@/lib/findings/telemetry";
import { getSandboxInfoForInstance } from "./utils/sandbox-types";

type ReportResult = {
  success: boolean;
  error?: string;
  validation_kind?: string;
  warning?: string;
  finding_id?: string;
  updated_at?: number;
  report?: {
    finding_id: string;
    updated_at: number;
    evidence_verification?: { warning?: string };
  };
};

/** Observe returned rejections as well as thrown failures without changing tool semantics. */
export function observeFindingTool<I, O extends ReportResult>(
  context: ToolContext,
  operation: "create" | "list" | "get" | "update",
  getCurrentSandbox: () => AnySandbox | null,
  execute: (input: I, options: ToolExecutionOptions) => Promise<O>,
) {
  return async (input: I, options: ToolExecutionOptions): Promise<O> => {
    const started = Date.now();
    const capture = (event: Omit<FindingEvent, "operation">) => {
      // Observability must never turn an accepted write into an apparent failure.
      try {
        const sandbox = getCurrentSandbox();
        const transport = sandbox
          ? getSandboxInfoForInstance(sandbox).type
          : "not_acquired";
        const fields = {
          ...findingEventProperties({
            ...event,
            operation,
            duration_ms: Date.now() - started,
          }),
          userId: context.userID,
          tool_call_id: options.toolCallId,
          ...(context.triggerRunId && { trigger_run_id: context.triggerRunId }),
          mode: context.mode,
          transport,
          runtime: context.triggerRunId ? "trigger" : "web",
          ...(process.env.VERCEL_GIT_COMMIT_SHA && {
            release: process.env.VERCEL_GIT_COMMIT_SHA,
          }),
        };
        phLogger.event("finding_operation_completed", fields);
        phLogger.info("finding.operation_completed", fields);
      } catch {
        /* best effort */
      }
    };
    try {
      const result = await execute(input, options);
      const missingProvenance =
        (operation === "create" || operation === "update") &&
        !context.assistantMessageId;
      const reason = missingProvenance
        ? "provenance"
        : (
            [
              "validation",
              "conflict",
              "duplicate",
              "not_found",
              "chat_not_found",
            ] as const
          ).find((value) => value === result.error);
      capture({
        outcome: result.success
          ? "success"
          : reason
            ? "rejected"
            : operation === "create" || operation === "update"
              ? "uncertain"
              : "failed",
        ...(!result.success && {
          reason:
            result.validation_kind === "evidence"
              ? "evidence"
              : (reason ?? "general"),
        }),
        ...(result.success && {
          finding_id: result.finding_id ?? result.report?.finding_id,
          report_updated_at: result.updated_at ?? result.report?.updated_at,
          evidence_warning: Boolean(
            result.warning || result.report?.evidence_verification?.warning,
          ),
        }),
      });
      return result;
    } catch (error) {
      capture({
        outcome: options.abortSignal?.aborted ? "canceled" : "failed",
        reason: "general",
      });
      throw error;
    }
  };
}
