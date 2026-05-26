import type { User } from "@workos-inc/node";
import { phLogger } from "@/lib/posthog/server";

export function captureUserSignedUp({
  user,
  workosEventId,
  workosEventCreatedAt,
  referralAttribution,
}: {
  user: User;
  workosEventId: string;
  workosEventCreatedAt: string;
  referralAttribution?: {
    referrerUserId: string;
    referralCode: string;
    referralLandingPath?: string;
  } | null;
}) {
  phLogger.event("user_signed_up", {
    userId: user.id,
    signup_source: "workos_user_created_webhook",
    email_verified: user.emailVerified,
    locale: user.locale,
    user_created_at: user.createdAt,
    workos_event_id: workosEventId,
    workos_event_created_at: workosEventCreatedAt,
    referrer_user_id: referralAttribution?.referrerUserId,
    referral_code: referralAttribution?.referralCode,
    referral_landing_path: referralAttribution?.referralLandingPath,
    $insert_id: workosEventId,
    $set_once: {
      signed_up_at: user.createdAt,
      signup_source: "workos_user_created_webhook",
      initial_locale: user.locale,
    },
    $set: {
      email_verified: user.emailVerified,
    },
  });
}
