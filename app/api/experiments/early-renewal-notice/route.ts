import type { NextRequest } from "next/server";
import PostHogClient from "@/app/posthog";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { EARLY_RENEWAL_NOTICE_FLAG } from "@/lib/billing/early-renewal-notice";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

/**
 * Assignment only. Live billing status decides whether a notice is shown, and
 * the browser records exposure when it actually renders one.
 */
export async function GET(req: NextRequest) {
  let enabled = false;
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    // Team billing has its own administrators. Free tokens are not excluded:
    // a past-due subscriber's entitlement can already have dropped to free.
    const posthog = subscription === "team" ? null : PostHogClient();
    if (posthog) {
      enabled =
        (await getPostHogFlagWithoutExposure(
          posthog,
          EARLY_RENEWAL_NOTICE_FLAG,
          userId,
        )) === true;
    }
  } catch {
    // Unauthenticated, missing, or failed evaluation keeps the notice off.
    enabled = false;
  }
  return Response.json({ enabled }, { headers: NO_STORE_HEADERS });
}
