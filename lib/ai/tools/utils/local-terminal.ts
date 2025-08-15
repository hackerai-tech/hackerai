import { exec, spawn } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import type { UIMessageStreamWriter } from "ai";

const execAsync = promisify(exec);

export interface LocalTerminalOptions {
  cwd?: string;
  user?: string;
  onStdout?: (output: string) => void;
  onStderr?: (output: string) => void;
  background?: boolean;
}

export interface LocalTerminalResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  pid?: number;
}

export const executeLocalCommand = async (
  command: string,
  options: LocalTerminalOptions = {},
): Promise<LocalTerminalResult> => {
  const {
    cwd = process.cwd(),
    onStdout,
    onStderr,
    background = false,
  } = options;

  if (background) {
    return executeBackgroundCommand(command, { cwd, onStdout, onStderr });
  }

  try {
    if (onStdout || onStderr) {
      // Use streaming execution for real-time output
      return executeStreamingCommand(command, { cwd, onStdout, onStderr });
    } else {
      // Use simple execution for commands that don't need streaming
      const { stdout, stderr } = await execAsync(command, { cwd });
      return { stdout, stderr, exitCode: 0 };
    }
  } catch (error: unknown) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number;
    };
    return {
      stdout: execError.stdout || "",
      stderr:
        execError.stderr || execError.message || "Command execution failed",
      exitCode: execError.code || 1,
    };
  }
};

const executeStreamingCommand = (
  command: string,
  options: {
    cwd: string;
    onStdout?: (output: string) => void;
    onStderr?: (output: string) => void;
  },
): Promise<LocalTerminalResult> => {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      const output = data.toString();
      stdout += output;
      options.onStdout?.(output);
    });

    child.stderr?.on("data", (data) => {
      const output = data.toString();
      stderr += output;
      options.onStderr?.(output);
    });

    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
        pid: child.pid,
      });
    });

    child.on("error", (error) => {
      resolve({
        stdout,
        stderr: stderr + error.message,
        exitCode: 1,
      });
    });
  });
};

const executeBackgroundCommand = (
  command: string,
  options: {
    cwd: string;
    onStdout?: (output: string) => void;
    onStderr?: (output: string) => void;
  },
): Promise<LocalTerminalResult> => {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    child.stdout?.on("data", (data) => {
      const output = data.toString();
      options.onStdout?.(output);
    });

    child.stderr?.on("data", (data) => {
      const output = data.toString();
      options.onStderr?.(output);
    });

    // For background processes, resolve immediately with the PID
    resolve({
      stdout: `Background process started with PID: ${child.pid}\n`,
      stderr: "",
      exitCode: 0,
      pid: child.pid,
    });

    // Unref the child process so it can run independently
    child.unref();
  });
};

export const createLocalTerminalHandlers = (
  writer: UIMessageStreamWriter,
  toolCallId: string,
) => {
  const terminalSessionId = `terminal-${randomUUID()}`;
  let outputCounter = 0;

  return {
    onStdout: (output: string) => {
      writer.write({
        type: "data-terminal",
        id: `${terminalSessionId}-${++outputCounter}`,
        data: { terminal: output, toolCallId },
      });
    },
    onStderr: (output: string) => {
      writer.write({
        type: "data-terminal",
        id: `${terminalSessionId}-${++outputCounter}`,
        data: { terminal: output, toolCallId },
      });
    },
  };
};
