/**
 * Request-lifetime guidance for one tool that keeps failing with varied calls.
 *
 * The exact tool/input/result cycle detector cannot see a model that changes
 * arguments while the same tool keeps failing. This tracker counts only
 * explicit structural failures from first-party tools with known result
 * shapes; text is never scanned, so output content cannot look like failure.
 * It only adds guidance: a run of failing diagnostic commands is normal work,
 * so no tool is excluded and no run is stopped.
 *
 * Adapted from the same-tool failure warning, failure-tolerant terminal policy
 * and progress reset in Hermes Agent's tool guardrails, without its hard stop
 * or text-marker fallback:
 * https://github.com/NousResearch/hermes-agent/blob/4162ecf11f611400fa6e5c42d2f360188ce50b39/agent/tool_guardrails.py
 */

export type ToolFailureNotice = { toolName: string; failureCount: number };

type ToolCall = { toolCallId: string; toolName: string; input: unknown };
type ToolResult = { toolCallId: string; output: unknown };
/**
 * `succeeded` (a known read) resets only that tool. `progress` (a landed
 * change) and `unknown` (no trusted evidence either way) reset every tool.
 */
type ToolOutcome = "failed" | "succeeded" | "progress" | "unknown";

/** Guidance is prepared at every third consecutive failure of one tool. */
export const TOOL_FAILURE_NOTICE_INTERVAL = 3;
/** Actual exposures per request, shared by replacement provider streams. */
export const MAX_TOOL_FAILURE_NOTICES = 2;

/** Cancellation is the user's decision, not evidence that an approach failed. */
const INTERRUPTED_EXIT_CODE = 130;
/** Same per-step bound as the exact-cycle observer; larger steps are a gap. */
const MAX_OBSERVED_STEP_ITEMS = 64;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype;

const fileAction = ({
  toolName,
  input,
}: Pick<ToolCall, "toolName" | "input">) =>
  toolName === "file_edit"
    ? "edit"
    : (toolName === "file" || toolName === "file_write") && isPlainObject(input)
      ? input.action
      : undefined;

/** Success envelopes returned by `file` actions in lib/ai/tools/file.ts. */
function classifyFileSuccess(action: unknown, output: unknown): ToolOutcome {
  if (action === "write")
    return typeof output === "string" ? "progress" : "unknown";
  if (!isPlainObject(output) || typeof output.content !== "string")
    return "unknown";
  if (action === "append" || action === "edit") return "progress";
  if (action === "read") return "succeeded";
  if (action === "view" && output.action === "view") return "succeeded";
  return "unknown";
}

/**
 * Finished exit status from run_terminal_cmd: top-level `exitCode` for
 * ordinary commands, `exited.exitCode` for an interactive PTY that finished
 * during launch. A running, signal-killed or contradictory process is unknown.
 */
function terminalExitCode(result: Record<string, unknown>): number | undefined {
  const nested =
    result.exited === undefined
      ? undefined
      : isPlainObject(result.exited)
        ? result.exited.exitCode
        : null;
  const codes = [result.exitCode, nested].filter((code) => code !== undefined);
  const [code] = codes;
  if (
    typeof code !== "number" ||
    !Number.isInteger(code) ||
    codes.some((other) => other !== code) ||
    (result.status === "failed" && code === 0) ||
    (result.status === "completed" && code !== 0)
  )
    return undefined;
  return code;
}

/**
 * Permission denials, cancellation, unknown command outcomes and unrecognized
 * shapes are unknown. Other tools are unknown until their shapes are added.
 */
export function classifyToolOutcome(
  call: Pick<ToolCall, "toolName" | "input">,
  output: unknown,
): ToolOutcome {
  if (call.toolName === "run_terminal_cmd") {
    const result = isPlainObject(output) ? output.result : undefined;
    if (
      !isPlainObject(result) ||
      result.approvalDenied === true ||
      result.executionOutcome !== undefined
    )
      return "unknown";
    const code = terminalExitCode(result);
    if (code === undefined || code === INTERRUPTED_EXIT_CODE) return "unknown";
    return code === 0 ? "progress" : "failed";
  }
  const action = fileAction(call);
  if (action === undefined) return "unknown";
  if (isPlainObject(output) && "error" in output) {
    return typeof output.error === "string" && output.approvalDenied !== true
      ? "failed"
      : "unknown";
  }
  return classifyFileSuccess(action, output);
}

/** Retains only per-tool counts and one pending notice; never call content. */
export class ToolFailureRecovery {
  private failures = new Map<string, number>();
  private pending: ToolFailureNotice | undefined;
  private exposures = 0;

  getPendingNotice(): ToolFailureNotice | undefined {
    return this.exposures < MAX_TOOL_FAILURE_NOTICES ? this.pending : undefined;
  }

  /** Call only when the notice reached an actual provider request. */
  recordExposure(notice: ToolFailureNotice): void {
    this.exposures++;
    if (this.pending === notice) this.pending = undefined;
  }

  /** A gap in trusted evidence never extends an earlier streak. */
  reset(): void {
    this.failures.clear();
    this.pending = undefined;
  }

  /**
   * Returns a newly reached threshold. `armNotice: false` still counts the
   * failures but defers guidance, including an unexposed earlier notice, to
   * another detector that covers the same steps, such as an exact result cycle.
   */
  observe(
    calls: readonly ToolCall[],
    results: readonly ToolResult[],
    { armNotice }: { armNotice: boolean },
  ): ToolFailureNotice | undefined {
    if (
      calls.length > MAX_OBSERVED_STEP_ITEMS ||
      results.length > MAX_OBSERVED_STEP_ITEMS
    ) {
      this.reset();
      return undefined;
    }
    let reached: ToolFailureNotice | undefined;
    for (const call of calls) {
      const result = results.find(
        (entry) => entry.toolCallId === call.toolCallId,
      );
      // A missing result (including a thrown tool error) is a gap in evidence.
      const outcome = result
        ? classifyToolOutcome(call, result.output)
        : "unknown";
      if (outcome === "unknown" || outcome === "progress") {
        this.reset();
        reached = undefined;
      } else if (outcome === "succeeded") {
        this.failures.delete(call.toolName);
        if (this.pending?.toolName === call.toolName) this.pending = undefined;
        if (reached?.toolName === call.toolName) reached = undefined;
      } else {
        const failureCount = (this.failures.get(call.toolName) ?? 0) + 1;
        this.failures.set(call.toolName, failureCount);
        if (failureCount % TOOL_FAILURE_NOTICE_INTERVAL === 0)
          reached = { toolName: call.toolName, failureCount };
      }
    }
    if (!armNotice) this.pending = undefined;
    if (!reached || !armNotice) return undefined;
    if (this.exposures < MAX_TOOL_FAILURE_NOTICES) this.pending = reached;
    return reached;
  }
}

/** Fixed guidance; the tool name comes from the first-party allowlist above. */
export function buildToolFailureNotice({
  toolName,
  failureCount,
}: ToolFailureNotice): string {
  const specific =
    toolName === "run_terminal_cmd"
      ? "Failing diagnostic commands are acceptable, so keep using tools, but do not keep varying the same failing approach. Read the latest error and exit status, run one small check of the shared prerequisite (working directory, required files, installed programs, permissions or network access), then change the approach based on that evidence."
      : "Read the latest error before the next call. Confirm the target path exists and re-read its current content before changing it; for edits, copy find strings exactly from the current file. If this tool cannot inspect the target, use another tool.";
  return (
    `[REPEATED TOOL FAILURES] ${toolName} has returned ${failureCount} failed results without a successful result in between. ${specific} ` +
    "If a prerequisite is missing or outside your control, stop retrying, explain the blocker and state what remains unverified. Never describe failed or unverified work as complete."
  );
}
