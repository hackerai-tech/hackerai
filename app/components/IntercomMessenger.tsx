"use client";

import { useEffect } from "react";
import type { IntercomMessengerIdentity } from "@/lib/intercom/messenger";
import { shutdownIntercomSession } from "@/lib/intercom/client";

let activeUserId: string | null = null;

export function IntercomMessenger({
  identity,
}: {
  identity: IntercomMessengerIdentity | null;
}) {
  useEffect(() => {
    if (!identity) {
      shutdownIntercomSession();
      activeUserId = null;
      return;
    }

    let cancelled = false;

    void import("@intercom/messenger-js-sdk")
      .then((intercom) => {
        if (cancelled) return;

        const settings = {
          app_id: identity.appId,
          api_base: identity.apiBase,
          intercom_user_jwt: identity.userJwt,
          hide_default_launcher: true,
          hide_notifications: true,
        };

        if (!activeUserId) {
          intercom.default(settings);
        } else if (activeUserId === identity.userId) {
          intercom.update(settings);
        } else {
          intercom.shutdown();
          intercom.boot(settings);
        }

        activeUserId = identity.userId;
      })
      .catch(() => {
        // Support still opens anonymously if the optional widget is blocked.
      });

    return () => {
      cancelled = true;
    };
  }, [identity]);

  return null;
}
