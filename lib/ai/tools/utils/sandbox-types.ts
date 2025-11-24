import type { Sandbox } from "@e2b/code-interpreter";
import type { ConvexSandbox } from "./convex-sandbox";
import type { AnySandbox } from "@/types";

/**
 * Type guard to check if a sandbox is an E2B Sandbox
 */
export function isE2BSandbox(sandbox: AnySandbox | null): sandbox is Sandbox {
  return sandbox !== null && "jupyterUrl" in sandbox;
}

/**
 * Type guard to check if a sandbox is a ConvexSandbox
 */
export function isConvexSandbox(
  sandbox: AnySandbox | null,
): sandbox is ConvexSandbox {
  return sandbox !== null && !("jupyterUrl" in sandbox);
}

/**
 * Common sandbox interface that both E2B and ConvexSandbox implement
 */
export interface CommonSandboxInterface {
  commands: {
    run: (
      command: string,
      opts?: {
        envVars?: Record<string, string>;
        cwd?: string;
        timeoutMs?: number;
        background?: boolean;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
      },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  files: {
    write: (path: string, content: string | Buffer) => Promise<void>;
    read: (path: string) => Promise<string>;
    remove: (path: string) => Promise<void>;
    list: (path: string) => Promise<{ name: string }[]>;
  };
  getHost: (port: number) => string;
  close: () => Promise<void>;
}

/**
 * Get the sandbox as the common interface type
 */
export function asCommonSandbox(sandbox: AnySandbox): CommonSandboxInterface {
  return sandbox as unknown as CommonSandboxInterface;
}
