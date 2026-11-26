/**
 * A run_terminal_cmd start receipt is the structured `output.result` evidence
 * the egress review accepts as proof that a command started
 * (convex/egressAbuseReview.ts). Compaction replaces bulky terminal results
 * with a one-line summary. For an exec whose structured result already carries
 * a receipt, it keeps only `processStarted: true` beside that summary, never
 * the PID, session or raw result. Start is never derived from summary text,
 * exit codes, stdout or the command string.
 */

const COMPACTED = "__hackeraiStorageCompacted";

export type CompactTerminalReceipt = {
  result: { output: string; processStarted: true };
  [COMPACTED]: true;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The review's acceptance rule for a structured terminal result. */
export function hasTerminalStartReceipt(output: unknown): boolean {
  const result = isRecord(output) ? output.result : undefined;
  if (!isRecord(result) || result.approvalDenied === true) return false;
  return (
    result.processStarted === true ||
    (typeof result.pid === "number" && result.pid > 0) ||
    (typeof result.session === "string" && result.session.length > 0)
  );
}

type TerminalPart = {
  type?: unknown;
  state?: unknown;
  input?: unknown;
  output?: unknown;
};

/** A completed exec with a nonblank command and an accepted receipt. */
export function isStartedTerminalExec(part: TerminalPart): boolean {
  if (
    part.type !== "tool-run_terminal_cmd" ||
    part.state !== "output-available"
  )
    return false;
  const input = isRecord(part.input) ? part.input : undefined;
  return (
    !!input &&
    (input.action === undefined || input.action === "exec") &&
    typeof input.command === "string" &&
    input.command.trim() !== "" &&
    hasTerminalStartReceipt(part.output)
  );
}

export const compactTerminalReceipt = (
  summary: string,
): CompactTerminalReceipt => ({
  result: { output: summary, processStarted: true },
  [COMPACTED]: true,
});

/** The summary of an output in exactly the compact receipt shape. */
export function compactTerminalReceiptSummary(
  output: unknown,
): string | undefined {
  if (
    !isRecord(output) ||
    output[COMPACTED] !== true ||
    Object.keys(output).length !== 2 ||
    !isRecord(output.result)
  )
    return undefined;
  const { result } = output;
  return Object.keys(result).length === 2 &&
    result.processStarted === true &&
    typeof result.output === "string"
    ? result.output
    : undefined;
}

const withoutStartReceipt = (output: unknown): unknown => {
  const summary = compactTerminalReceiptSummary(output);
  if (summary !== undefined) return summary;
  if (!isRecord(output) || !isRecord(output.result)) return output;
  const {
    processStarted: _processStarted,
    pid: _pid,
    session: _session,
    ...result
  } = output.result;
  return { ...output, result };
};

/**
 * A later compaction stage that clips, replaces or removes a terminal input
 * removes the start receipt, so no reader pairs it with another command.
 */
export function dropReceiptUnlessExecRetained<T extends TerminalPart>(
  before: TerminalPart,
  after: T,
): T {
  if (
    after.type !== "tool-run_terminal_cmd" ||
    !hasTerminalStartReceipt(after.output)
  )
    return after;
  const original = isRecord(before.input) ? before.input : undefined;
  const current = isRecord(after.input) ? after.input : undefined;
  if (
    original &&
    current &&
    current.command === original.command &&
    current.action === original.action
  )
    return after;
  return { ...after, output: withoutStartReceipt(after.output) };
}
