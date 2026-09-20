"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type { SetSandboxPreference } from "./useSandboxPreference";
import {
  connectionMatchesPreference,
  environmentPreference,
  isEnvironmentPreference,
} from "@/lib/sandbox/environment";
import type {
  ChatMode,
  SandboxPreference,
  SelectedModel,
  SubscriptionTier,
} from "@/types/chat";

interface RemoteConnection {
  connectionId: string;
  environmentId?: string;
  isDesktop: boolean;
}

interface UseNewRemoteConnectionArgs {
  connections: RemoteConnection[] | undefined;
  enabled?: boolean;
  onNewConnection: (connection: RemoteConnection) => void;
}

const REMOTE_CONNECTION_SELECTION_REQUEST_EVENT =
  "hackerai:remote-connection-selection-request";
const REMOTE_CONNECTION_SELECTION_REQUEST_TTL_MS = 5 * 60 * 1000;

interface RemoteConnectionSelectionRequest {
  sandboxPreference: SandboxPreference;
  requestedAt: number;
}

/** Allows the next newly connected runner to replace this unavailable selection. */
export function requestRemoteConnectionSelection(
  sandboxPreference: SandboxPreference,
) {
  window.dispatchEvent(
    new CustomEvent<RemoteConnectionSelectionRequest>(
      REMOTE_CONNECTION_SELECTION_REQUEST_EVENT,
      {
        detail: { sandboxPreference, requestedAt: Date.now() },
      },
    ),
  );
}

/** Detects remote connections added after the current session baseline. */
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
  isNewChat: boolean;
  hasExplicitSandboxPreference: boolean;
  chatMode: ChatMode;
  setChatMode: (mode: ChatMode) => void;
  subscription: SubscriptionTier;
  freeSubscriptionResolved: boolean;
  sandboxPreference: SandboxPreference;
  setSandboxPreference: SetSandboxPreference;
  selectedModel: SelectedModel;
  setSelectedModel: (model: SelectedModel) => void;
}

/** Selects a newly connected remote machine from any mounted app surface. */
export function useAutoSelectNewRemoteConnection({
  connections,
  enabled,
  isNewChat,
  hasExplicitSandboxPreference,
  chatMode,
  setChatMode,
  subscription,
  freeSubscriptionResolved,
  sandboxPreference,
  setSandboxPreference,
  selectedModel,
  setSelectedModel,
}: UseAutoSelectNewRemoteConnectionArgs) {
  const pendingReconnectRef = useRef<RemoteConnectionSelectionRequest | null>(
    null,
  );

  useEffect(() => {
    if (!enabled) {
      pendingReconnectRef.current = null;
      return;
    }

    const handleSelectionRequest = (event: Event) => {
      const request = (event as CustomEvent<RemoteConnectionSelectionRequest>)
        .detail;
      if (request?.sandboxPreference) {
        pendingReconnectRef.current = request;
      }
    };

    window.addEventListener(
      REMOTE_CONNECTION_SELECTION_REQUEST_EVENT,
      handleSelectionRequest,
    );
    return () =>
      window.removeEventListener(
        REMOTE_CONNECTION_SELECTION_REQUEST_EVENT,
        handleSelectionRequest,
      );
  }, [enabled]);

  const selectNewConnection = useCallback(
    (connection: RemoteConnection) => {
      // Stable selections reconnect through identity resolution, never through
      // the legacy "next runner" heuristic (even after clicking Reconnect).
      if (isEnvironmentPreference(sandboxPreference)) return;
      const pendingReconnect = pendingReconnectRef.current;
      const reconnectRequested = Boolean(
        pendingReconnect &&
        pendingReconnect.sandboxPreference === sandboxPreference &&
        Date.now() - pendingReconnect.requestedAt <=
          REMOTE_CONNECTION_SELECTION_REQUEST_TTL_MS,
      );
      if (pendingReconnect && !reconnectRequested) {
        pendingReconnectRef.current = null;
      }

      // An untouched new-task default may follow a newly connected runner.
      // Replacing a saved local connection requires an explicit Reconnect
      // action so an unrelated runner cannot silently take over the task.
      if (
        !isNewChat ||
        (hasExplicitSandboxPreference &&
          (sandboxPreference === "e2b" || !reconnectRequested))
      )
        return;

      const selectedConnectionAvailable = connections?.some((candidate) =>
        connectionMatchesPreference(candidate, sandboxPreference),
      );
      if (
        sandboxPreference !== "e2b" &&
        sandboxPreference !== connection.connectionId &&
        selectedConnectionAvailable
      ) {
        return;
      }

      pendingReconnectRef.current = null;
      if (sandboxPreference !== connection.connectionId) {
        setSandboxPreference(environmentPreference(connection), {
          remember: reconnectRequested,
        });
      }

      if (
        freeSubscriptionResolved &&
        subscription === "free" &&
        selectedModel !== "auto"
      ) {
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
      connections,
      isNewChat,
      hasExplicitSandboxPreference,
      sandboxPreference,
      selectedModel,
      setChatMode,
      setSandboxPreference,
      setSelectedModel,
      subscription,
      freeSubscriptionResolved,
    ],
  );

  useNewRemoteConnection({
    connections,
    enabled,
    onNewConnection: selectNewConnection,
  });
}
