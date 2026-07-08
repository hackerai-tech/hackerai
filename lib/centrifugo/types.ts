export interface CommandMessage {
  type: "command";
  commandId: string;
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  background?: boolean;
  displayName?: string;
  targetConnectionId: string;
}

export interface CommandCancelMessage {
  type: "command_cancel";
  commandId: string;
  targetConnectionId: string;
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

// -- Native desktop file relay messages (server -> desktop bridge) ----------

export interface FileStatMessage {
  type: "file_stat";
  requestId: string;
  path: string;
  targetConnectionId: string;
}

export interface FileReadMessage {
  type: "file_read";
  requestId: string;
  path: string;
  range?: [number, number];
  maxFullBytes?: number;
  maxResultBytes?: number;
  targetConnectionId: string;
}

export interface FileWriteMessage {
  type: "file_write";
  requestId: string;
  path: string;
  content: string;
  isBase64?: boolean;
  targetConnectionId: string;
}

export interface FileAppendMessage {
  type: "file_append";
  requestId: string;
  path: string;
  content: string;
  targetConnectionId: string;
}

export interface FileRemoveMessage {
  type: "file_remove";
  requestId: string;
  path: string;
  targetConnectionId: string;
}

export interface FileListMessage {
  type: "file_list";
  requestId: string;
  path: string;
  targetConnectionId: string;
}

// -- Native desktop file relay messages (desktop bridge -> server) ----------

export interface FileOkMessage {
  type: "file_ok";
  requestId: string;
}

export interface FileErrorMessage {
  type: "file_error";
  requestId: string;
  message: string;
}

export interface FileStatResultMessage {
  type: "file_stat_result";
  requestId: string;
  kind: "file" | "missing" | "not_file";
  path: string;
  sizeBytes?: number;
}

export interface FileReadResultMessage {
  type: "file_read_result";
  requestId: string;
  path: string;
  sizeBytes: number;
  totalLines: number;
  content?: string;
  startLine?: number;
  tooLarge?: boolean;
  truncated?: boolean;
}

export interface FileListResultMessage {
  type: "file_list_result";
  requestId: string;
  entries: Array<{ name: string }>;
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
  targetConnectionId: string;
}

export interface PtyInputMessage {
  type: "pty_input";
  sessionId: string;
  data: string;
  targetConnectionId: string;
}

export interface PtyResizeMessage {
  type: "pty_resize";
  sessionId: string;
  cols: number;
  rows: number;
  targetConnectionId: string;
}

export interface PtyKillMessage {
  type: "pty_kill";
  sessionId: string;
  targetConnectionId: string;
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
  | CommandCancelMessage
  | StdoutMessage
  | StderrMessage
  | ExitMessage
  | ErrorMessage;

export type FileRequestMessage =
  | FileStatMessage
  | FileReadMessage
  | FileWriteMessage
  | FileAppendMessage
  | FileRemoveMessage
  | FileListMessage;

export type FileResponseMessage =
  | FileOkMessage
  | FileErrorMessage
  | FileStatResultMessage
  | FileReadResultMessage
  | FileListResultMessage;

/** Full union of all messages that travel over the sandbox Centrifugo channel. */
export type SandboxMessage =
  | CommandResponseMessage
  | FileRequestMessage
  | FileResponseMessage
  | PtyCreateMessage
  | PtyInputMessage
  | PtyResizeMessage
  | PtyKillMessage
  | PtyReadyMessage
  | PtyDataMessage
  | PtyExitMessage
  | PtyErrorMessage;

/**
 * Build the Centrifugo channel name for a single local/desktop sandbox
 * connection. The `#` segment keeps Centrifugo's user-limited channel check,
 * while the random connection id prevents same-user agents from sharing one
 * command stream.
 */
export function sandboxConnectionChannel(
  userId: string,
  connectionId: string,
): string {
  return `sandbox:connection:${connectionId}#${userId}`;
}
