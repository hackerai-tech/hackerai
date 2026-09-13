import type { User } from "@workos-inc/node";
import { phLogger } from "@/lib/posthog/server";

export function captureUserSignedUp({
  user,
  workosEventId,
  workosEventCreatedAt,
}: {
  user: User;
  workosEventId: string;
  workosEventCreatedAt: string;
}) {
  phLogger.event("user_signed_up", {
    userId: user.id,
    signup_source: "workos_user_created_webhook",
    email_verified: user.emailVerified,
    email_verified_at_creation: user.emailVerified,
    locale: user.locale,
    user_created_at: user.createdAt,
    workos_event_id: workosEventId,
    workos_event_created_at: workosEventCreatedAt,
    $insert_id: workosEventId,
    $set_once: {
      signed_up_at: user.createdAt,
      signup_source: "workos_user_created_webhook",
      initial_locale: user.locale,
      email_verified_at_creation: user.emailVerified,
    },
    ...(user.emailVerified
      ? {
          $set: {
            email_verified: true,
            email_verified_at: user.createdAt,
          },
        }
      : {}),
  });
}

export function captureUserEmailVerified({
  userId,
  workosEventId,
  workosEventCreatedAt,
}: {
  userId: string;
  workosEventId: string;
  workosEventCreatedAt: string;
}) {
  phLogger.event("user_email_verified", {
    userId,
    verification_source: "workos_authentication_email_verification_succeeded",
    email_verified: true,
    email_verified_at: workosEventCreatedAt,
    workos_event_id: workosEventId,
    workos_event_created_at: workosEventCreatedAt,
    $insert_id: workosEventId,
    $set: {
      email_verified: true,
      email_verified_at: workosEventCreatedAt,
    },
  });
}
