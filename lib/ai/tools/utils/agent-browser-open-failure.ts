import type { ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { detectAgentBrowserUsage } from "@/lib/utils/agent-browser-command";
import { stripAnsi } from "./pty-wait-utils";

// Public CLI markers only. These are hints from terminal text, not proof that
// the detected invocation ran or caused the shell's exit (e.g. compound scripts).
const PUBLIC_MARKERS = {
  daemon_start: /^(?:Daemon failed to start|Failed to start daemon):?\b/m,
  daemon_transport: /^Failed to (?:connect|send|read):/m,
  browser_launch: /^Chrome launch task failed:/m,
  navigation: /^(?:Navigation failed:|page\.goto:)/m,
} as const;

/** Best effort; never alters execution, retries, terminal output or child stdio. */
export function captureAgentBrowserOpenFailure(args: {
  context: Pick<ToolContext, "userID" | "chatId" | "triggerRunId">;
  command: string;
  interactive?: boolean;
  isBackground: boolean;
  aborted: boolean;
  result: Record<string, unknown>;
}): void {
  try {
    const r = args.result;
    if (
      args.interactive ||
      args.isBackground ||
      args.aborted ||
      r.processStarted !== true ||
      r.executionOutcome === "unknown" ||
      r.timedOut ||
      r.approvalDenied ||
      typeof r.exitCode !== "number" ||
      !Number.isInteger(r.exitCode) ||
      r.exitCode === 0 ||
      r.exitCode < 1 ||
      r.exitCode > 255
    )
      return;
    const usage = detectAgentBrowserUsage(args.command);
    if (!usage) return;
    const openIntent = usage.actions.includes("open");
    if (!openIntent && !usage.actions.includes("option")) return;

    let truncated = false;
    const samples = [r.output, r.error].map((value) => {
      if (typeof value !== "string") return "";
      // At most 8192 UTF-16 units across both fields, before ANSI stripping.
      if (value.length <= 4096) return stripAnsi(value);
      truncated = true;
      return (
        stripAnsi(value.slice(0, 2048)) + "\n" + stripAnsi(value.slice(-2048))
      );
    });
    const text = samples.join("\n").replace(/^[ \t]*[✗×][ \t]*/gm, "");
    const matches = Object.entries(PUBLIC_MARKERS)
      .filter(([, pattern]) => pattern.test(text))
      .map(([name]) => name);
    const runId = args.context.triggerRunId;
    const recordedRun =
      typeof runId === "string" && /^run_[a-z0-9]{20,40}$/.test(runId);
    phLogger.event("agent_browser_terminal_open_failure", {
      userId: args.context.userID,
      chat_id: args.context.chatId,
      browser_open_failure_version: 2,
      // Option-prefixed syntax is intentionally not parsed into an OPEN claim.
      observation_scope: openIntent
        ? "terminal_result_open_intent"
        : "terminal_result_option_intent",
      public_output_hint:
        matches.length > 1
          ? "multiple_markers"
          : (matches[0] ?? "no_known_marker"),
      output_sample_present: samples.some(Boolean),
      output_sample_truncated: truncated,
      detected_invocation_count: Math.min(usage.invocationCount, 16),
      exit_code: r.exitCode,
      owner_run_status: recordedRun ? "recorded" : "unavailable",
      ...(recordedRun && { owner_trigger_run_id: runId }),
    });
  } catch {
    // Diagnostics must not change the already-produced terminal result.
  }
}
