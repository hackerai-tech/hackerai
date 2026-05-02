/**
 * Shared logic for the shell / terminal tool UI.
 *
 * Used by both TerminalToolHandler (live chat) and
 * SharedMessagePartHandler (shared/read-only view).
 */

import type { SidebarTerminal } from "@/types/chat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShellAction = "exec" | "view" | "wait" | "send" | "kill";

export interface ShellToolInput {
  command?: string;
  action?: string;
  brief?: string;
  input?: string | string[];
  pid?: number;
  session?: string;
}

export interface ShellToolOutput {
  result?: {
    output?: string;
    stdout?: string;
    stderr?: string;
    error?: string;
    sessionSnapshot?: string;
    rawSnapshot?: string;
  };
  output?: string;
  exitCode?: number | null;
  pid?: number;
  session?: string;
  error?: boolean | string;
}

// ---------------------------------------------------------------------------
// Interactive action check
// ---------------------------------------------------------------------------

export function isInteractiveShellAction(action?: string): boolean {
  return (
    action === "send" ||
    action === "wait" ||
    action === "view" ||
    action === "kill"
  );
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

export function getShellActionLabel(opts: {
  isShellTool: boolean;
  action?: string;
  isActive?: boolean;
  /** Legacy run_terminal_cmd: input.interactive — true opens a PTY session. */
  interactive?: boolean;
  /** Legacy run_terminal_cmd: input.is_background — true runs detached. */
  isBackground?: boolean;
}): string {
  const {
    isShellTool,
    action,
    isActive = false,
    interactive,
    isBackground,
  } = opts;

  if (!isShellTool) {
    // For interactive / background, the verb is the action label and the
    // command flows in as the target — e.g. "Started interactive" + `bash`
    // reads as "Started interactive bash".
    if (interactive) {
      return isActive ? "Starting interactive" : "Started interactive";
    }
    if (isBackground) {
      return isActive ? "Starting background" : "Started background";
    }
    return isActive ? "Executing" : "Executed";
  }

  const entry = LABELS[action as ShellAction];
  if (!entry) return isActive ? "Executing" : "Executed";

  const [active, done] = entry;
  return isActive ? active : done;
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
// Display input — format raw send input for display
// ---------------------------------------------------------------------------

import { RAW_TO_KEY_NAME } from "@/lib/ai/tools/utils/pty-keys";

/**
 * Format raw `send` input for UI display.
 * - Literal escape sequences (\\n, \\t, \\xNN) → readable names
 * - ANSI escape sequences → tmux key name (e.g. "Up", "F1")
 * - Raw control characters → tmux key name (e.g. "C-d", "C-c")
 * - Plain text ending with newline → text without the trailing newline
 */
export function formatSendInput(raw: string): string {
  // Bare literal or actual newline → display as "Enter"
  if (
    raw === "\\n" ||
    raw === "\\r" ||
    raw === "\\r\\n" ||
    raw === "\n" ||
    raw === "\r\n" ||
    raw === "\r"
  ) {
    return "Enter";
  }

  // Strip trailing literal or actual newlines for display
  let display = raw
    .replace(/\\r\\n$/, "")
    .replace(/\\n$/, "")
    .replace(/\\r$/, "")
    .replace(/\r\n$/, "")
    .replace(/\n$/, "")
    .replace(/\r$/, "");

  // If nothing left after stripping, it was just Enter
  if (!display) return "Enter";

  // Map literal escape sequences to readable names for display
  // Order matters: process hex escapes first, then arrow sequences
  display = display
    // Control characters first (before arrow patterns match [C/[D inside them)
    .replace(/\\x03/g, "⌃C")
    .replace(/\\x04/g, "⌃D")
    .replace(/\\t/g, "⇥")
    // Arrow keys: \x1b[X or actual escape+[X or standalone [X
    .replace(/\\x1b\[A|\x1b\[A/g, "↑")
    .replace(/\\x1b\[B|\x1b\[B/g, "↓")
    .replace(/\\x1b\[C|\x1b\[C/g, "→")
    .replace(/\\x1b\[D|\x1b\[D/g, "←")
    // Escape character
    .replace(/\\e|\x1b/g, "⎋");

  // Clean up extra spaces
  display = display.replace(/\s+/g, " ").trim();

  // Exact match on known key / escape sequence (actual bytes)
  if (RAW_TO_KEY_NAME[display]) {
    return RAW_TO_KEY_NAME[display];
  }

  // Multiple non-printable characters → map each
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting raw control chars
  if (display.length > 0 && /^[\x00-\x1f\x7f]+$/.test(display)) {
    const names = [...display]
      .map(
        (ch) =>
          RAW_TO_KEY_NAME[ch] ??
          `0x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
      )
      .join(" ");
    return names;
  }

  return display;
}

// ---------------------------------------------------------------------------
// Display target — always shows the full command/brief
// ---------------------------------------------------------------------------

export function getShellDisplayTarget(
  input: ShellToolInput | undefined,
): string {
  // Interactive actions (view, wait, send, kill) all carry a `brief` written
  // by the model — show that as the target rather than the action verb, the
  // raw send keys, or the kill session id. The action label (e.g. "Sent
  // input [PID: 1234]") already conveys what happened.
  if (input?.action && isInteractiveShellAction(input.action)) {
    return input.brief || "";
  }
  return getShellDisplayCommand(input);
}

// ---------------------------------------------------------------------------
// Streaming terminal output — concat `data-terminal` parts for a toolCallId
// ---------------------------------------------------------------------------

interface DataTerminalPart {
  type: "data-terminal";
  data?: { toolCallId?: string; terminal?: string };
}

function isDataTerminalPart(part: unknown): part is DataTerminalPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "data-terminal"
  );
}

export function getStreamingTerminalOutput(
  parts: readonly unknown[] | undefined,
  toolCallId: string,
): string {
  if (!parts) return "";
  let out = "";
  for (const part of parts) {
    if (!isDataTerminalPart(part)) continue;
    if (part.data?.toolCallId !== toolCallId) continue;
    out += part.data.terminal ?? "";
  }
  return out;
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

// ---------------------------------------------------------------------------
// Unified ToolBlock + sidebar computation
//
// Both the live (TerminalToolHandler) and read-only (SharedMessagePartHandler)
// views need the same display logic: brief-only label for interactive actions,
// rawBytes routing for xterm vs shiki, and a full SidebarTerminal payload so
// the sidebar can render the interactive PTY view. This helper produces all
// of it from raw inputs so both renderers stay in lockstep.
// ---------------------------------------------------------------------------

export interface ComputeShellBlockArgs {
  isShellTool: boolean;
  shellInput: ShellToolInput | undefined;
  shellOutput: ShellToolOutput | undefined;
  errorText?: string;
  /** Live streaming output accumulated from data-terminal parts. Empty for shared view. */
  streamingOutput?: string;
  isExecuting: boolean;
  hasResult: boolean;
  toolCallId: string;
  /** Legacy run_terminal_cmd: input.interactive — true if PTY-backed. */
  legacyInteractive?: boolean;
  /** Legacy run_terminal_cmd: input.is_background — true if detached. */
  legacyIsBackground?: boolean;
  /** Legacy run_terminal_cmd: input.command. */
  legacyCommand?: string;
}

export interface ShellBlockComputed {
  shellAction: string | undefined;
  isInteractiveAction: boolean;
  blockAction: (isActive: boolean) => string;
  blockTarget: string | undefined;
  finalOutput: string;
  sidebarContent: SidebarTerminal | null;
}

export function computeShellTerminalBlock(
  args: ComputeShellBlockArgs,
): ShellBlockComputed {
  const {
    isShellTool,
    shellInput,
    shellOutput,
    errorText,
    streamingOutput = "",
    isExecuting,
    hasResult,
    toolCallId,
    legacyInteractive,
    legacyIsBackground,
    legacyCommand,
  } = args;

  const shellAction = isShellTool ? shellInput?.action : undefined;
  const isInteractiveAction = isInteractiveShellAction(shellAction);

  const displayCommand = isShellTool
    ? getShellDisplayCommand(shellInput) ||
      (isInteractiveAction ? shellAction || "" : "")
    : legacyCommand || "";
  const displayTarget = isShellTool
    ? getShellDisplayTarget(shellInput) || displayCommand
    : displayCommand;

  // Brief-only label: drop the verb prefix ("Sent input", "Viewed", "Killed",
  // "Executed") and let the model's brief stand alone. Applied to:
  //   - interactive PTY actions (always — the verb is too generic without it)
  //   - exec / legacy run_terminal_cmd, but only AFTER the command has fully
  //     run, so the user still sees the live command while it's executing.
  const briefText = shellInput?.brief || "";
  const useBriefOnly =
    !!briefText &&
    ((isShellTool && isInteractiveAction) ||
      (!isInteractiveAction && hasResult));
  const blockAction = (isActive: boolean) =>
    useBriefOnly
      ? briefText
      : getShellActionLabel({
          isShellTool,
          action: shellAction,
          isActive,
          interactive: !isShellTool ? legacyInteractive : undefined,
          isBackground: !isShellTool ? legacyIsBackground : undefined,
        });
  const blockTarget = useBriefOnly ? undefined : displayTarget;

  // sessionSnapshot is xterm-headless-cleaned — prefer it when present; fall
  // back to streaming for live interactive output, then to plain getShellOutput.
  const sessionSnapshot = shellOutput?.result?.sessionSnapshot;
  const finalOutput =
    sessionSnapshot && hasResult
      ? sessionSnapshot
      : isInteractiveAction && streamingOutput
        ? streamingOutput
        : sessionSnapshot
          ? sessionSnapshot
          : getShellOutput(shellOutput, { streamingOutput, errorText });

  // Only feed rawBytes (→ xterm renderer) for interactive PTY contexts.
  // Plain non-interactive exec output is line-oriented; the shiki ANSI
  // renderer handles it without dragging in xterm.js.
  const isInteractiveContext =
    isInteractiveAction || (!isShellTool && !!legacyInteractive);
  const rawSnapshot = shellOutput?.result?.rawSnapshot;
  const effectiveRawBytes = isInteractiveContext
    ? hasResult && rawSnapshot
      ? rawSnapshot
      : streamingOutput || rawSnapshot || undefined
    : undefined;

  const shellPid = shellInput?.pid ?? shellOutput?.pid;
  const shellSession = shellInput?.session ?? shellOutput?.session;

  const sidebarContent: SidebarTerminal | null =
    !displayCommand && !isInteractiveAction
      ? null
      : {
          command: isInteractiveAction ? displayTarget : displayCommand,
          output: finalOutput,
          isExecuting,
          isBackground: !isShellTool ? legacyIsBackground : undefined,
          isInteractive: !isShellTool ? legacyInteractive : undefined,
          toolCallId,
          shellAction,
          pid: shellPid,
          session: shellSession,
          input: shellInput?.input,
          rawBytes: effectiveRawBytes,
        };

  return {
    shellAction,
    isInteractiveAction,
    blockAction,
    blockTarget,
    finalOutput,
    sidebarContent,
  };
}
