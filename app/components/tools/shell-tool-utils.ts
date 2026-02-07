/**
 * Shared logic for the shell / terminal tool UI.
 *
 * Used by both TerminalToolHandler (live chat) and
 * SharedMessagePartHandler (shared/read-only view).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShellAction = "exec" | "view" | "wait" | "send" | "kill";

export interface ShellToolInput {
  command?: string;
  action?: string;
  brief?: string;
  pid?: number;
}

export interface ShellToolOutput {
  result?: {
    output?: string;
    stdout?: string;
    stderr?: string;
    error?: string;
  };
  output?: string;
  exitCode?: number | null;
  pid?: number;
  error?: boolean | string;
}

// ---------------------------------------------------------------------------
// Action label
// ---------------------------------------------------------------------------

const LABELS: Record<ShellAction, [active: string, done: string]> = {
  exec: ["Executing", "Executed"],
  view: ["Viewing", "Viewed"],
  wait: ["Waiting", "Waited"],
  send: ["Sending input", "Sent input"],
  kill: ["Killing", "Killed"],
};

/** Actions whose action label should include PID. */
const PID_LABEL_ACTIONS = new Set<ShellAction>(["view", "wait", "kill"]);

export function getShellActionLabel(opts: {
  isShellTool: boolean;
  action?: string;
  pid?: number;
  isActive?: boolean;
}): string {
  const { isShellTool, action, pid, isActive = false } = opts;

  if (!isShellTool) return isActive ? "Executing" : "Executed";

  const entry = LABELS[action as ShellAction];
  if (!entry) return isActive ? "Executing" : "Executed";

  const [active, done] = entry;
  const label = isActive ? active : done;
  if (action && PID_LABEL_ACTIONS.has(action as ShellAction) && pid) {
    return `${label} [PID: ${pid}]`;
  }
  return label;
}

// ---------------------------------------------------------------------------
// Display command — the one-liner shown in the ToolBlock target
// ---------------------------------------------------------------------------

export function getShellDisplayCommand(
  input: ShellToolInput | undefined,
): string {
  return input?.command || input?.brief || "";
}

// ---------------------------------------------------------------------------
// Display target — always shows the full command/brief
// ---------------------------------------------------------------------------

export function getShellDisplayTarget(
  input: ShellToolInput | undefined,
): string {
  return getShellDisplayCommand(input);
}

// ---------------------------------------------------------------------------
// Output extraction — unified fallback chain for shell + legacy formats
// ---------------------------------------------------------------------------

export function getShellOutput(
  output: ShellToolOutput | undefined,
  extra?: { streamingOutput?: string; errorText?: string },
): string {
  const shellOutput = typeof output?.output === "string" ? output.output : "";
  const result = output?.result;
  const newFormatOutput = result?.output ?? "";
  const legacyOutput = (result?.stdout ?? "") + (result?.stderr ?? "");

  return (
    shellOutput ||
    newFormatOutput ||
    legacyOutput ||
    extra?.streamingOutput ||
    (result?.error ?? "") ||
    (typeof output?.error === "string" ? output.error : "") ||
    extra?.errorText ||
    ""
  );
}
