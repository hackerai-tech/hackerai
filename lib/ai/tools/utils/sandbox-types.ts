import type { Sandbox } from "@e2b/code-interpreter";
import type { CentrifugoSandbox } from "./centrifugo-sandbox";
import type { MiosaSandbox } from "./miosa-sandbox";
import type { AnySandbox, SandboxInfo } from "@/types";
import type { CloudSandboxProvider } from "./cloud-sandbox-provider";

export interface OsInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
}

export interface ConnectionInfo {
  connectionId: string;
  name: string;
  osInfo?: OsInfo;
  lastSeen?: number;
  isDesktop?: boolean;
  capabilities?: {
    commands: boolean;
    pty: boolean;
    files?: boolean;
  };
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
 * Type guard to check if a sandbox is an E2B Sandbox.
 *
 * Any sandbox that is neither Centrifugo nor MIOSA is treated as E2B. PTY
 * availability should be checked at the call site via `sandbox.pty`, not here.
 */
export function isE2BSandbox(sandbox: AnySandbox | null): sandbox is Sandbox {
  if (sandbox === null) return false;
  if (isCentrifugoSandbox(sandbox)) return false;
  if (isMiosaSandbox(sandbox)) return false;
  return true;
}

/** Type guard for the HackerAI MIOSA SDK adapter. */
export function isMiosaSandbox(
  sandbox: AnySandbox | null,
): sandbox is MiosaSandbox {
  return (
    sandbox !== null &&
    "sandboxKind" in sandbox &&
    (sandbox as { sandboxKind?: unknown }).sandboxKind === "miosa"
  );
}

/** Any remotely hosted cloud sandbox, regardless of provider SDK. */
export function isCloudSandbox(
  sandbox: AnySandbox | null,
): sandbox is Sandbox | MiosaSandbox {
  return isE2BSandbox(sandbox) || isMiosaSandbox(sandbox);
}

export function getCloudSandboxProviderForInstance(
  sandbox: AnySandbox | null,
): CloudSandboxProvider | null {
  if (isMiosaSandbox(sandbox)) return "miosa";
  if (isE2BSandbox(sandbox)) return "e2b";
  return null;
}

/** Canonical runtime identity used by sandbox logs and analytics. */
export function getSandboxInfoForInstance(sandbox: AnySandbox): SandboxInfo {
  const provider = getCloudSandboxProviderForInstance(sandbox);
  if (provider) return { type: "cloud", provider };

  if (!isCentrifugoSandbox(sandbox)) {
    return { type: "cloud", provider: "e2b" };
  }
  const connection =
    typeof sandbox.getConnectionInfo === "function"
      ? sandbox.getConnectionInfo()
      : undefined;
  const isDesktop =
    connection?.isDesktop ??
    (typeof sandbox.supportsNativeFileRelay === "function" &&
      sandbox.supportsNativeFileRelay());
  return {
    type: isDesktop ? "desktop" : "remote-connection",
    ...(connection?.name && { name: connection.name }),
  };
}

export function getSandboxLogFields(sandbox: AnySandbox): {
  sandbox_type: SandboxInfo["type"];
  sandbox_provider?: CloudSandboxProvider;
} {
  const info = getSandboxInfoForInstance(sandbox);
  return {
    sandbox_type: info.type,
    ...(info.provider && { sandbox_provider: info.provider }),
  };
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
        signal?: AbortSignal;
      },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  files: {
    write: (path: string, content: string | Buffer) => Promise<void>;
    read: (path: string) => Promise<string>;
    remove: (path: string) => Promise<void>;
    list: (path: string) => Promise<{ name: string }[]>;
  };
  getHost: (port: number) => string | Promise<string>;
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
