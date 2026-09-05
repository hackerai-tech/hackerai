"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type {
  ChatMode,
  SandboxPreference,
  SelectedModel,
  SubscriptionTier,
} from "@/types/chat";

interface RemoteConnection {
  connectionId: string;
  isDesktop: boolean;
}

interface UseNewRemoteConnectionArgs {
  connections: RemoteConnection[] | undefined;
  enabled?: boolean;
  onNewConnection: (connection: RemoteConnection) => void;
}

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

    // Existing connections are only a baseline. Select a machine when its
    // connection appears during this browser session, not on page load.
    if (previousConnectionIds === null) return;

    const newConnection = remoteConnections.find(
      (connection) => !previousConnectionIds.has(connection.connectionId),
    );
    if (newConnection) {
      onNewConnectionRef.current(newConnection);
    }
  }, [connections, enabled]);
}

interface UseAutoSelectNewRemoteConnectionArgs {
  connections: RemoteConnection[] | undefined;
  enabled: boolean;
  chatMode: ChatMode;
  setChatMode: (mode: ChatMode) => void;
  subscription: SubscriptionTier;
  sandboxPreference: SandboxPreference;
  setSandboxPreference: (preference: SandboxPreference) => void;
  selectedModel: SelectedModel;
  setSelectedModel: (model: SelectedModel) => void;
}

export function useAutoSelectNewRemoteConnection({
  connections,
  enabled,
  chatMode,
  setChatMode,
  subscription,
  sandboxPreference,
  setSandboxPreference,
  selectedModel,
  setSelectedModel,
}: UseAutoSelectNewRemoteConnectionArgs) {
  const selectNewConnection = useCallback(
    (connection: RemoteConnection) => {
      if (sandboxPreference !== connection.connectionId) {
        setSandboxPreference(connection.connectionId);
      }

      if (subscription === "free" && selectedModel !== "auto") {
        setSelectedModel("auto");
      }

      if (chatMode !== "agent") {
        setChatMode("agent");
        toast.success(
          "Local machine connected and selected. Switched to Agent mode.",
        );
      } else {
        toast.success("Local machine connected and selected.");
      }
    },
    [
      chatMode,
      sandboxPreference,
      selectedModel,
      setChatMode,
      setSandboxPreference,
      setSelectedModel,
      subscription,
    ],
  );

  useNewRemoteConnection({
    connections,
    enabled,
    onNewConnection: selectNewConnection,
  });
}
