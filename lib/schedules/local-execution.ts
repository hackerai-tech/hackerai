import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { queryLiveSandboxConnectionIds } from "@/lib/ai/tools/utils/hybrid-sandbox-manager";
import { resolveEnvironmentConnection } from "@/lib/sandbox/environment";

/** Require live relay presence, not a recently cached heartbeat, before unattended work. */
export async function findScheduledConnection(
  userId: string,
  preference: string,
) {
  const connections = await getConvexClient().query(
    api.localSandbox.listConnectionsForBackend,
    {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
    },
  );
  const connection = resolveEnvironmentConnection(
    connections.filter((c) => c.capabilities.commands),
    preference,
  );
  if (!connection) return null;
  const presence = await queryLiveSandboxConnectionIds(userId, [
    connection.connectionId,
  ]);
  if (!presence.reliable)
    throw new Error("Could not verify the computer connection.");
  return presence.onlineConnectionIds.has(connection.connectionId)
    ? connection
    : null;
}

/** A run is pinned to one relay session. Reconnection requires a new explicit run. */
export function watchScheduledConnection({
  userId,
  connectionId,
  onLost,
}: {
  userId: string;
  connectionId: string;
  onLost: () => void;
}) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    const presence = await queryLiveSandboxConnectionIds(userId, [
      connectionId,
    ]);
    if (disposed) return;
    if (!presence.reliable || !presence.onlineConnectionIds.has(connectionId)) {
      disposed = true;
      onLost();
      return;
    }
    timer = setTimeout(() => void check(), 5000);
  };
  timer = setTimeout(() => void check(), 5000);
  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}
