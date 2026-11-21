"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { isTauriEnvironment } from "@/app/hooks/useTauri";
import {
  useAgentInputNotifications,
  useDesktopNotificationOpen,
} from "@/app/hooks/useAgentInputNotifications";
import {
  detectAgentInputTransport,
  readAgentInputNotificationsEnabled,
  subscribeAgentInputNotificationsEnabled,
  type AgentInputTransport,
} from "@/lib/chat/agent-input-notifications";

export function useAgentInputNotificationsEnabled(
  userId: string | undefined,
): boolean {
  const subscribe = useCallback(
    (onChange: () => void) =>
      userId
        ? subscribeAgentInputNotificationsEnabled(userId, onChange)
        : () => undefined,
    [userId],
  );
  return useSyncExternalStore(
    subscribe,
    () => (userId ? readAgentInputNotificationsEnabled(userId) : false),
    () => false,
  );
}

function AgentInputNotificationSubscriber({
  userId,
  transport,
}: {
  userId: string;
  transport: AgentInputTransport;
}) {
  useAgentInputNotifications(userId, transport);
  return null;
}

function DesktopNotificationOpener() {
  useDesktopNotificationOpen();
  return null;
}

/**
 * Delivers alerts for an opted-in account on a supported surface. Permission
 * is checked when sending, so regranting it takes effect without a remount.
 */
export function AgentInputNotifications() {
  const { user } = useAuth();
  const userId = user?.id;
  const enabled = useAgentInputNotificationsEnabled(userId);
  // While Convex auth loads, the query answers as signed out; a baseline
  // taken then would make every existing wait look new once auth resolves.
  const { isAuthenticated } = useConvexAuth();
  const [transport] = useState(() =>
    detectAgentInputTransport(isTauriEnvironment()),
  );
  if (!userId || !transport) return null;

  return (
    <>
      {transport === "desktop" && <DesktopNotificationOpener key={userId} />}
      {enabled && isAuthenticated && (
        <AgentInputNotificationSubscriber
          key={`${userId}:${transport}`}
          userId={userId}
          transport={transport}
        />
      )}
    </>
  );
}
