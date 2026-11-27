/**
 * Terminal start evidence for the egress review (convex/egressAbuseReview.ts).
 *
 * A started run_terminal_cmd exec carries a structured start receipt in
 * `output.result`. Compaction replaces that result with its legacy summary
 * string, unchanged, so every reader of `output` sees what it always saw. For
 * an exec whose structured result already passes the review's rule, the part
 * also keeps `terminalStartReceipt: true`. The review accepts that sidecar only
 * on rows whose parts the Agent worker attested (`terminal_evidence_state`).
 * Start is never derived from summary text, exit codes, stdout or the command.
 */

type TerminalPart = {
  type?: unknown;
  state?: unknown;
  toolCallId?: unknown;
  input?: unknown;
  output?: unknown;
  terminalStartReceipt?: unknown;
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

/** A completed exec with a nonblank command: the only part a receipt fits. */
const isCompletedExec = (part: TerminalPart): boolean => {
  const input = isRecord(part.input) ? part.input : undefined;
  return (
    part.type === "tool-run_terminal_cmd" &&
    part.state === "output-available" &&
    !!input &&
    (input.action === undefined || input.action === "exec") &&
    typeof input.command === "string" &&
    input.command.trim() !== ""
  );
};

/** A completed exec whose structured result has an accepted receipt. */
export const isStartedTerminalExec = (part: TerminalPart): boolean =>
  isCompletedExec(part) && hasTerminalStartReceipt(part.output);

const withoutStructuredReceipt = (output: unknown): unknown => {
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
 * A later compaction stage that clips, replaces or removes a terminal input,
 * or leaves a part a receipt cannot fit, removes the start receipt, so no
 * reader pairs it with another command.
 */
export function dropReceiptUnlessExecRetained<T extends TerminalPart>(
  before: TerminalPart,
  after: T,
): T {
  if (
    after.type !== "tool-run_terminal_cmd" ||
    (!("terminalStartReceipt" in after) &&
      !hasTerminalStartReceipt(after.output))
  )
    return after;
  const original = isRecord(before.input) ? before.input : undefined;
  const current = isRecord(after.input) ? after.input : undefined;
  const inputRetained =
    !!original &&
    !!current &&
    current.command === original.command &&
    current.action === original.action;
  const sidecarFits =
    !("terminalStartReceipt" in after) ||
    (after.terminalStartReceipt === true && isCompletedExec(after));
  if (inputRetained && sidecarFits) return after;
  const { terminalStartReceipt: _receipt, ...part } = after;
  return (
    inputRetained
      ? part
      : { ...part, output: withoutStructuredReceipt(part.output) }
  ) as T;
}

export type TerminalCall =
  | {
      started: true;
      toolCallId: string;
      command: string;
    }
  | { started: false };

/**
 * How the egress review reads one message part: a started exec with its
 * command, a call it counts as incomplete, or undefined for anything else.
 * Interactive sends are always incomplete: their keystrokes may hold a
 * password, a reply or a command, so they are never read.
 */
export function readTerminalCall(
  raw: unknown,
  { acceptSidecar }: { acceptSidecar: boolean },
): TerminalCall | undefined {
  const part = (isRecord(raw) ? raw : {}) as TerminalPart;
  const input = isRecord(part.input) ? part.input : undefined;
  if (part.type === "tool-interact_terminal_session")
    return input?.action === "send" ? { started: false } : undefined;
  if (part.type !== "tool-run_terminal_cmd") return undefined;
  if (input?.action && input.action !== "exec") return undefined;
  const command = input?.command;
  if (
    part.state !== "output-available" ||
    !(
      hasTerminalStartReceipt(part.output) ||
      (acceptSidecar && part.terminalStartReceipt === true)
    ) ||
    typeof part.toolCallId !== "string" ||
    !part.toolCallId ||
    part.toolCallId.length > 128 ||
    typeof command !== "string" ||
    !command.trim()
  )
    return { started: false };
  return { started: true, toolCallId: part.toolCallId, command };
}

/**
 * The worker's attestation for a save: `complete` only when storage
 * compaction left every terminal call the review reads exactly as it read the
 * worker's parts before compaction. Trimming other parts does not matter;
 * dropping, clipping or losing the start of any terminal call does.
 */
export function terminalEvidenceAfterCompaction(
  before: readonly unknown[],
  after: readonly unknown[],
): "complete" | "incomplete" {
  const read = (parts: readonly unknown[]) =>
    JSON.stringify(
      parts.flatMap(
        (part) => readTerminalCall(part, { acceptSidecar: true }) ?? [],
      ),
    );
  return read(before) === read(after) ? "complete" : "incomplete";
}
