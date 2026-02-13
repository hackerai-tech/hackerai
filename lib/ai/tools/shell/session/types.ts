/**
 * Session management types for the shell tool.
 *
 * TmuxSandbox is the minimal interface required for tmux-based terminal
 * sessions. Both E2B Sandbox and local ConvexSandbox satisfy this via
 * their `commands.run()` method.
 */

export interface TmuxSandbox {
  commands: {
    run: (
      command: string,
      opts?: {
        timeoutMs?: number;
        displayName?: string;
        /** Optional stdout callback for streaming (E2B supports this). */
        onStdout?: (data: string) => void;
        [key: string]: unknown;
      },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  /** If true, the sandbox supports streaming via onStdout callback. */
  supportsStreaming?: boolean;
}

export interface LocalPtySession {
  tmuxSessionName: string;
  /** Full captured output from the last capture-pane call. */
  lastCapturedOutput: string;
}

export class TmuxNotAvailableError extends Error {
  constructor(
    message = "tmux is not installed and could not be auto-installed. " +
      "Install it manually to enable full terminal features (wait, send, kill):\n" +
      "  macOS:   brew install tmux\n" +
      "  Linux:   sudo apt-get install tmux  (or: dnf, apk, yum)\n" +
      "  Windows: available via WSL or Docker (tmux is not native to Windows)",
  ) {
    super(message);
    this.name = "TmuxNotAvailableError";
  }
}
