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

/** Actions whose action label should include session/PID info. */
const SESSION_LABEL_ACTIONS = new Set<ShellAction>([
  "view",
  "wait",
  "send",
  "kill",
]);

export function getShellActionLabel(opts: {
  isShellTool: boolean;
  action?: string;
  pid?: number;
  session?: string;
  isActive?: boolean;
}): string {
  const { isShellTool, action, pid, session, isActive = false } = opts;

  if (!isShellTool) return isActive ? "Executing" : "Executed";

  const entry = LABELS[action as ShellAction];
  if (!entry) return isActive ? "Executing" : "Executed";

  const [active, done] = entry;
  const label = isActive ? active : done;
  if (action && SESSION_LABEL_ACTIONS.has(action as ShellAction)) {
    if (pid) return `${label} [PID: ${pid}]`;
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
// Display input — format raw send input for display
// ---------------------------------------------------------------------------

import { RAW_TO_KEY_NAME } from "@/lib/ai/tools/utils/pty-keys";

/**
 * Format raw `send` input for UI display.
 * - ANSI escape sequences → tmux key name (e.g. "Up", "F1")
 * - Raw control characters → tmux key name (e.g. "C-d", "C-c")
 * - Plain text ending with `\n` → text without the trailing newline
 * - Already-readable tmux names like "C-c" pass through unchanged
 */
export function formatSendInput(raw: string): string {
  // Bare newline → display as "Enter"
  if (raw === "\n" || raw === "\r\n" || raw === "\r") {
    return "Enter";
  }

  const stripped = raw.replace(/\n$/, "");

  // Exact match on known key / escape sequence
  if (RAW_TO_KEY_NAME[stripped]) {
    return RAW_TO_KEY_NAME[stripped];
  }

  // Multiple non-printable characters → map each
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting raw control chars
  if (stripped.length > 0 && /^[\x00-\x1f\x7f]+$/.test(stripped)) {
    const names = [...stripped]
      .map(
        (ch) =>
          RAW_TO_KEY_NAME[ch] ??
          `0x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
      )
      .join(" ");
    return names;
  }

  // Regular text — strip trailing newline for display
  return stripped || raw;
}

// ---------------------------------------------------------------------------
// Display target — always shows the full command/brief
// ---------------------------------------------------------------------------

export function getShellDisplayTarget(
  input: ShellToolInput | undefined,
): string {
  if (input?.action === "send" && input.input) {
    if (Array.isArray(input.input)) {
      return input.input.map((t) => formatSendInput(t)).join(" ");
    }
    return formatSendInput(input.input);
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
