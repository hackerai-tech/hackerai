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

export type SandboxMessage =
  | CommandMessage
  | StdoutMessage
  | StderrMessage
  | ExitMessage
  | ErrorMessage;

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
