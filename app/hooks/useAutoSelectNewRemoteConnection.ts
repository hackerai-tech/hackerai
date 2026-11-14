"use client";

import { useEffect, useRef } from "react";

interface RemoteConnection {
  connectionId: string;
  isDesktop: boolean;
}

interface UseNewRemoteConnectionArgs {
  connections: RemoteConnection[] | undefined;
  enabled?: boolean;
  onNewConnection: (connection: RemoteConnection) => void;
}

/** Detects a new runner for UI status only. Selection requires a user action. */
export function useNewRemoteConnection({
  connections,
  enabled = true,
  onNewConnection,
}: UseNewRemoteConnectionArgs) {
  const previousConnectionIdsRef = useRef<Set<string> | null>(null);
  const onNewConnectionRef = useRef(onNewConnection);

  useEffect(() => {
    onNewConnectionRef.current = onNewConnection;
  }, [onNewConnection]);

  useEffect(() => {
    if (!enabled) {
      previousConnectionIdsRef.current = null;
      return;
    }
    if (connections === undefined) return;

    const remoteConnections = connections.filter(
      (connection) => !connection.isDesktop,
    );
    const currentConnectionIds = new Set(
      remoteConnections.map((connection) => connection.connectionId),
    );
    const previousConnectionIds = previousConnectionIdsRef.current;
    previousConnectionIdsRef.current = currentConnectionIds;

    if (previousConnectionIds === null) return;
    const newConnection = remoteConnections.find(
      (connection) => !previousConnectionIds.has(connection.connectionId),
    );
    if (newConnection) onNewConnectionRef.current(newConnection);
  }, [connections, enabled]);
}
