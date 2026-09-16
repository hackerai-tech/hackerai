"use client";

import { useEffect } from "react";
import type { IntercomMessengerIdentity } from "@/lib/intercom/messenger";
import { shutdownIntercomSession } from "@/lib/intercom/client";

let activeUserId: string | null = null;
let hasInitializedMessenger = false;

/** Keeps the hidden Intercom session aligned with the authenticated app user. */
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

        if (!hasInitializedMessenger) {
          intercom.default(settings);
          hasInitializedMessenger = true;
        } else if (!activeUserId) {
          intercom.boot(settings);
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
