import type { Sandbox } from "@e2b/code-interpreter";
import type { CentrifugoSandbox } from "./centrifugo-sandbox";
import type { AnySandbox } from "@/types";

export interface OsInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
}

export interface ConnectionInfo {
  connectionId: string;
  name: string;
  mode: "docker" | "dangerous";
  osInfo?: OsInfo;
  containerId?: string;
  lastSeen?: number;
}

/**
 * Type guard to check if a sandbox is a CentrifugoSandbox
 * using the `sandboxKind` discriminant field.
 */
export function isCentrifugoSandbox(
  sandbox: AnySandbox | null,
): sandbox is CentrifugoSandbox {
  return (
    sandbox !== null &&
    "sandboxKind" in sandbox &&
    (sandbox as any).sandboxKind === "centrifugo"
  );
}

/**
 * Type guard to check if a sandbox is an E2B Sandbox
 */
export function isE2BSandbox(sandbox: AnySandbox | null): sandbox is Sandbox {
  return sandbox !== null && !isCentrifugoSandbox(sandbox);
}

/**
 * Common sandbox interface that both E2B and CentrifugoSandbox implement
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
 * Get the sandbox as the common interface type.
 * The `as unknown as` cast is necessary because E2B's Sandbox is an external
 * type with a structurally incompatible interface (e.g. different method
 * signatures, extra properties). Both sandbox implementations satisfy
 * CommonSandboxInterface at runtime, but TypeScript cannot verify this
 * structurally across the external type boundary.
 */
export function asCommonSandbox(sandbox: AnySandbox): CommonSandboxInterface {
  return sandbox as unknown as CommonSandboxInterface;
}
