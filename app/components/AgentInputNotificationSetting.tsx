"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Switch } from "@/components/ui/switch";
import { isTauriEnvironment } from "@/app/hooks/useTauri";
import { useAgentInputNotificationsEnabled } from "./AgentInputNotifications";
import {
  detectAgentInputTransport,
  enableAgentInputNotifications,
  readAgentInputPermission,
  writeAgentInputNotificationsEnabled,
  type AgentInputPermission,
  type AgentInputTransport,
} from "@/lib/chat/agent-input-notifications";

const copy = {
  desktop: {
    description: "Alert me when Agent needs an answer or approval",
    blocked:
      "Notifications are blocked for HackerAI. Allow them in your system notification settings",
  },
  browser: {
    description:
      "Alert me when Agent needs an answer or approval. Works while a HackerAI tab is open.",
    blocked:
      "Notifications are blocked for this site. Allow them in your browser's site settings",
  },
} satisfies Record<AgentInputTransport, Record<string, string>>;

/** Settings > Agents row. Hidden where notifications cannot work. */
export function AgentInputNotificationSetting() {
  const { user } = useAuth();
  const userId = user?.id;
  const enabled = useAgentInputNotificationsEnabled(userId);
  const [transport] = useState(() =>
    detectAgentInputTransport(isTauriEnvironment()),
  );
  const [permission, setPermission] = useState<AgentInputPermission | null>(
    null,
  );
  const [requesting, setRequesting] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const statusId = useId();

  const refreshPermission = useCallback(() => {
    if (!transport) return () => undefined;
    let current = true;
    void readAgentInputPermission(transport).then((next) => {
      if (current) setPermission(next);
    });
    return () => {
      current = false;
    };
  }, [transport]);

  useEffect(() => {
    let cancel = refreshPermission();
    // Pick up changes made in system or browser settings.
    const handleFocus = () => {
      cancel();
      cancel = refreshPermission();
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      cancel();
      window.removeEventListener("focus", handleFocus);
    };
  }, [refreshPermission]);

  // Older Desktop builds and unsupported browsers get no unusable toggle.
  if (!userId || !transport || !permission || permission === "unavailable") {
    return null;
  }

  // Shows the saved opt-in even when the OS later blocks alerts, so it can be
  // turned off without a prompt. A reset permission needs a fresh request.
  const checked = enabled && permission !== "prompt";
  const blocked = permission === "denied";

  const handleCheckedChange = async (next: boolean) => {
    if (!next) {
      writeAgentInputNotificationsEnabled(userId, false);
      return;
    }
    const request = enableAgentInputNotifications(userId, transport);
    setRequesting(true);
    try {
      setPermission(await request);
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between py-3 border-b gap-3">
        <div className="flex-1 min-w-0">
          <div id={titleId} className="font-medium">
            Agent input notifications
          </div>
          <div id={descriptionId} className="text-sm text-muted-foreground">
            {copy[transport].description}
          </div>
          {blocked && (
            <p
              id={statusId}
              role="status"
              className="pt-2 text-sm text-amber-600 dark:text-amber-400"
            >
              {copy[transport].blocked}
              {checked ? "." : ", then turn this on."}
            </p>
          )}
        </div>
        <Switch
          className="mt-1 shrink-0"
          aria-labelledby={titleId}
          aria-describedby={
            blocked ? `${descriptionId} ${statusId}` : descriptionId
          }
          checked={checked}
          disabled={requesting}
          onCheckedChange={(next) => void handleCheckedChange(next)}
        />
      </div>
    </div>
  );
}
