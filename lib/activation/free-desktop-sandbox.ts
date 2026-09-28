import type { SandboxPreference } from "@/types/chat";
import {
  connectionMatchesPreference,
  environmentPreference,
} from "@/lib/sandbox/environment";

interface LocalSandboxConnection {
  connectionId: string;
  environmentId?: string;
  isDesktop: boolean;
}

interface FreeDesktopSandboxState {
  sandboxPreference: SandboxPreference;
  desktopBridgeActive: boolean;
  localConnections: readonly LocalSandboxConnection[] | undefined;
}

export function resolveFreeDesktopSandboxPreference({
  sandboxPreference,
  desktopBridgeActive,
  localConnections,
}: FreeDesktopSandboxState): SandboxPreference {
  // A disconnected computer is still the selected computer. Only choose a
  // default when the current environment is Cloud, which free Agent cannot use.
  if (sandboxPreference !== "e2b") {
    return sandboxPreference;
  }

  if (desktopBridgeActive) return "desktop";

  const remoteConnection = localConnections?.find(
    (connection) => !connection.isDesktop,
  );
  return remoteConnection ? environmentPreference(remoteConnection) : "desktop";
}

export function isFreeDesktopSandboxAvailable({
  sandboxPreference,
  desktopBridgeActive,
  localConnections,
}: FreeDesktopSandboxState): boolean {
  if (sandboxPreference === "desktop") return desktopBridgeActive;
  if (sandboxPreference === "e2b") return false;
  return Boolean(
    localConnections?.some((connection) =>
      connectionMatchesPreference(connection, sandboxPreference),
    ),
  );
}
