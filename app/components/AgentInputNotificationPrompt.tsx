"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isTauriEnvironment } from "@/app/hooks/useTauri";
import {
  claimAgentInputNotificationOffer,
  detectAgentInputTransport,
  enableAgentInputNotifications,
  isDocumentForeground,
  readAgentInputNotificationsPreference,
  readAgentInputPermission,
  subscribeAgentInputNotificationsEnabled,
} from "@/lib/chat/agent-input-notifications";

/**
 * One-time offer shown with the first real Agent question or approval seen in
 * the foreground. Key it by account, chat and request so state never carries
 * over. Permission is requested only from the Enable click.
 */
export function AgentInputNotificationPrompt({ userId }: { userId: string }) {
  const [transport] = useState(() =>
    detectAgentInputTransport(isTauriEnvironment()),
  );
  const [open, setOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const subscribe = useCallback(
    (onChange: () => void) =>
      subscribeAgentInputNotificationsEnabled(userId, onChange),
    [userId],
  );
  // A choice made in Settings, here or in another window closes the offer.
  const preference = useSyncExternalStore(
    subscribe,
    () => readAgentInputNotificationsPreference(userId),
    () => null,
  );

  useEffect(() => {
    if (!transport || preference !== null) return;
    let active = true;
    let claiming = false;
    let listening = false;
    const shouldClaim = () => active && isDocumentForeground();
    const stopListening = () => {
      if (!listening) return;
      listening = false;
      window.removeEventListener("focus", tryClaim);
      document.removeEventListener("visibilitychange", tryClaim);
    };
    function tryClaim() {
      if (claiming || !shouldClaim()) return;
      claiming = true;
      void claimAgentInputNotificationOffer(userId, shouldClaim).then(
        (claimed) => {
          claiming = false;
          if (!active) return;
          if (claimed) setOpen(true);
          // Keep waiting only when the page lost the foreground mid-claim.
          if (claimed || shouldClaim()) stopListening();
        },
      );
    }

    void readAgentInputPermission(transport).then((permission) => {
      if (!active || permission === "unavailable" || permission === "denied")
        return;
      listening = true;
      window.addEventListener("focus", tryClaim);
      document.addEventListener("visibilitychange", tryClaim);
      tryClaim();
    });
    return () => {
      active = false;
      stopListening();
    };
  }, [transport, userId, preference]);

  if (!transport || !open || preference !== null) return null;

  const enable = () => {
    if (requesting) return;
    // Start the request first so browsers see the click's user activation.
    const request = enableAgentInputNotifications(userId, transport);
    setRequesting(true);
    setSaveFailed(false);
    void request.then(
      ({ permission, saved }) => {
        setRequesting(false);
        // Granted but not saved means alerts stay off; keep the offer to retry.
        if (permission === "granted" && !saved) setSaveFailed(true);
        else setOpen(false);
      },
      () => {
        setRequesting(false);
        setOpen(false);
      },
    );
  };

  return (
    <div className="@container mb-2 min-w-0">
      <div
        role="group"
        aria-label="Agent input notifications"
        aria-busy={requesting || undefined}
        className="flex min-h-11 min-w-0 flex-col gap-1 rounded-2xl border bg-muted py-1.5 pl-3.5 pr-1.5 @min-[30rem]:flex-row @min-[30rem]:items-center @min-[30rem]:gap-3"
        data-testid="agent-input-notification-prompt"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5 pr-2 pt-1 @min-[30rem]:pr-0 @min-[30rem]:pt-0">
          <Bell
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm leading-5 text-foreground">
              Get notified next time Agent needs you
            </p>
            <p
              role="status"
              className="text-xs leading-4 text-amber-600 dark:text-amber-400"
            >
              {saveFailed
                ? "Couldn’t save your notification setting. Try again."
                : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 rounded-full text-muted-foreground sm:h-8"
            disabled={requesting}
            onClick={() => setOpen(false)}
          >
            Not now
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 rounded-full sm:h-8"
            disabled={requesting}
            onClick={enable}
          >
            Enable notifications
          </Button>
        </div>
      </div>
    </div>
  );
}
