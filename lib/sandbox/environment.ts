/** A logical environment survives replacement of its authenticated relay session. */
export interface EnvironmentConnection {
  connectionId: string;
  environmentId?: string;
  createdAt?: number;
  isDesktop?: boolean;
}

export const isEnvironmentPreference = (preference: string) =>
  preference.startsWith("environment:") ||
  preference.startsWith("desktop-environment:");

export const isDesktopPreference = (preference: string) =>
  preference === "desktop" || preference.startsWith("desktop-environment:");

export function environmentPreference(
  connection: EnvironmentConnection,
): string {
  if (!connection.isDesktop) return connection.connectionId;
  return connection.environmentId
    ? `desktop-environment:${connection.environmentId}`
    : "desktop";
}

/**
 * Identity for work and approvals performed inside a local environment.
 * Native Desktop has an authenticated registration path. Bearer-token runners
 * remain scoped to the exact relay session, even when they claim a stable ID.
 */
export function localEnvironmentIdentity(
  connection: EnvironmentConnection,
): string {
  return connection.isDesktop && connection.environmentId
    ? environmentPreference(connection)
    : connection.connectionId;
}

export function connectionMatchesPreference(
  connection: EnvironmentConnection,
  preference: string,
): boolean {
  if (preference === "desktop") return Boolean(connection.isDesktop);
  if (isEnvironmentPreference(preference)) {
    if (!connection.isDesktop || !isDesktopPreference(preference)) return false;
    return (
      connection.environmentId ===
        preference.slice(preference.indexOf(":") + 1) && connection.isDesktop
    );
  }
  return connection.connectionId === preference;
}

/** Input must already be filtered for readiness/health and ownership. */
export function resolveEnvironmentConnection<T extends EnvironmentConnection>(
  connections: readonly T[],
  preference: string,
  currentConnectionId?: string | null,
): T | undefined {
  const matches = connections.filter((connection) =>
    connectionMatchesPreference(connection, preference),
  );
  // Keep an active run on its healthy session; new tasks use the newest session.
  return (
    matches.find(
      (connection) => connection.connectionId === currentConnectionId,
    ) ?? matches.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
  );
}
