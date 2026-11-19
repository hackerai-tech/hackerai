"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  createAgentInputNotificationTracker,
  deliverAgentInputNotification,
  getBrowserNotificationPermission,
  isAgentInputChatId,
  isDocumentForeground,
  isPendingAgentInput,
  listenForDesktopNotificationOpen,
  readAgentInputNotificationsEnabled,
  showBrowserAgentInputNotification,
  showDesktopAgentInputNotification,
  type AgentInputTransport,
  type PendingAgentInput,
} from "@/lib/chat/agent-input-notifications";

function useOpenChat() {
  const router = useRouter();
  return useCallback(
    (chatId: string) => {
      // Open even if the wait was resolved elsewhere; the chat shows its state.
      if (isAgentInputChatId(chatId)) router.push(`/c/${chatId}`);
    },
    [router],
  );
}

/** Routes Desktop alert clicks, including alerts sent before an opt-out. */
export function useDesktopNotificationOpen(): void {
  const openChat = useOpenChat();
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listenForDesktopNotificationOpen(openChat).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openChat]);
}

/**
 * Observes saved Agent waits for one opted-in account. Each mount is a new
 * subscription whose first snapshot is a baseline, so reloads and newly
 * enabled settings do not replay old waits.
 */
export function useAgentInputNotifications(
  userId: string,
  transport: AgentInputTransport,
): void {
  const openChat = useOpenChat();
  const pending = useQuery(api.chats.getPendingAgentInputNotifications, {});
  const [tracker] = useState(createAgentInputNotificationTracker);
  const latestPendingRef = useRef<PendingAgentInput[] | undefined>(undefined);

  // A claim still queued after sign-out or an account switch must not alert.
  useEffect(
    () => () => {
      latestPendingRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    if (pending !== undefined) latestPendingRef.current = pending;
    for (const item of tracker.observe(pending)) {
      void deliverAgentInputNotification({
        userId,
        requestId: item.requestId,
        shouldDeliver: () =>
          isPendingAgentInput(latestPendingRef.current, item.requestId) &&
          readAgentInputNotificationsEnabled(userId) &&
          // Desktop checks its own windows natively; WebKit focus can be stale.
          (transport === "desktop" ||
            (!isDocumentForeground() &&
              getBrowserNotificationPermission() === "granted")),
        show: () =>
          transport === "desktop"
            ? showDesktopAgentInputNotification(item.chatId)
            : showBrowserAgentInputNotification(item, openChat),
      });
    }
  }, [openChat, pending, tracker, transport, userId]);
}
