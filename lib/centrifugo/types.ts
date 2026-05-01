export interface CommandMessage {
  type: "command";
  commandId: string;
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  background?: boolean;
  displayName?: string;
  targetConnectionId?: string;
}

export interface StdoutMessage {
  type: "stdout";
  commandId: string;
  data: string;
}

export interface StderrMessage {
  type: "stderr";
  commandId: string;
  data: string;
}

export interface ExitMessage {
  type: "exit";
  commandId: string;
  exitCode: number;
  pid?: number;
}

export interface ErrorMessage {
  type: "error";
  commandId: string;
  message: string;
}

// ── PTY incoming messages (server → local runner / desktop bridge) ────

export interface PtyCreateMessage {
  type: "pty_create";
  sessionId: string;
  command: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  targetConnectionId?: string;
}

export interface PtyInputMessage {
  type: "pty_input";
  sessionId: string;
  data: string;
  targetConnectionId?: string;
}

export interface PtyResizeMessage {
  type: "pty_resize";
  sessionId: string;
  cols: number;
  rows: number;
  targetConnectionId?: string;
}

export interface PtyKillMessage {
  type: "pty_kill";
  sessionId: string;
  targetConnectionId?: string;
}

// ── PTY outgoing messages (local runner / desktop bridge → server) ────

export interface PtyReadyMessage {
  type: "pty_ready";
  sessionId: string;
  pid: number;
}

export interface PtyDataMessage {
  type: "pty_data";
  sessionId: string;
  data: string;
}

export interface PtyExitMessage {
  type: "pty_exit";
  sessionId: string;
  exitCode: number;
}

export interface PtyErrorMessage {
  type: "pty_error";
  sessionId: string;
  message: string;
}

/** Command-only response subset — used by one-shot command execution. */
export type CommandResponseMessage =
  | CommandMessage
  | StdoutMessage
  | StderrMessage
  | ExitMessage
  | ErrorMessage;

/** Full union of all messages that travel over the sandbox Centrifugo channel. */
export type SandboxMessage =
  | CommandResponseMessage
  | PtyCreateMessage
  | PtyInputMessage
  | PtyResizeMessage
  | PtyKillMessage
  | PtyReadyMessage
  | PtyDataMessage
  | PtyExitMessage
  | PtyErrorMessage;

/**
 * Build the Centrifugo channel name for a user's sandbox.
 * The `#` is Centrifugo's user channel boundary separator: with
 * `allow_user_limited_channels: true` in the server config, Centrifugo
 * restricts subscription to clients whose JWT `sub` claim matches the
 * segment after `#`.
 */
export function sandboxChannel(userId: string): string {
  return `sandbox:user#${userId}`;
}
