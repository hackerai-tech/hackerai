import { after, NextRequest, NextResponse } from "next/server";
import { getConvexClient } from "@/lib/db/convex-client";
import type { Event } from "@workos-inc/node";
import { api } from "@/convex/_generated/api";
import { workos } from "@/app/api/workos";
import {
  captureUserEmailVerified,
  captureUserSignedUp,
} from "@/lib/analytics/user-signup";
import { phLogger } from "@/lib/posthog/server";
import { createFreeQuotaSubject } from "@/lib/auth/free-quota-subject";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * POST /api/workos/webhook
 * Handles WorkOS user lifecycle events for acquisition analytics.
 *
 * Configure in WorkOS Dashboard:
 * - Endpoint URL: https://your-domain.com/api/workos/webhook
 * - Events: user.created, authentication.email_verification_succeeded
 */
export async function POST(req: NextRequest) {
  const signature = req.headers.get("workos-signature");

  if (!signature) {
    logger.warn("Rejected WorkOS webhook without a signature", {
      event: "workos.webhook_missing_signature",
      request_id: req.headers.get("x-vercel-id") ?? "unknown",
      service: "hackerai-web",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
      route: "/api/workos/webhook",
    });
    return NextResponse.json(
      { error: "Missing workos-signature header" },
      { status: 400 },
    );
  }

  const webhookSecret = process.env.WORKOS_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[WorkOS Webhook] WORKOS_WEBHOOK_SECRET is not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch (error) {
    console.error("[WorkOS Webhook] Invalid JSON payload:", error);
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 },
    );
  }

  let event: Event;
  try {
    event = await workos.webhooks.constructEvent({
      payload,
      sigHeader: signature,
      secret: webhookSecret,
    });
  } catch (error) {
    console.error("[WorkOS Webhook] Signature verification failed:", error);
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 },
    );
  }

  let claimState: "acquired" | "already_processed" | "claim_held";
  try {
    const result = await getConvexClient().mutation(
      api.extraUsage.claimWebhookProcessing,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        eventId: event.id,
      },
    );
    claimState = result.state;
  } catch (error) {
    console.error("[WorkOS Webhook] Claim failed:", error);
    return NextResponse.json(
      { error: "Failed to claim webhook" },
      { status: 500 },
    );
  }

  if (claimState !== "acquired") {
    console.log(`[WorkOS Webhook] Event ${event.id} ${claimState}, skipping`);
    return NextResponse.json({ received: true });
  }

  try {
    if (event.event === "user.created") {
      const freeQuotaSubject = createFreeQuotaSubject(event.data.email);
      if (freeQuotaSubject) {
        await getConvexClient().mutation(api.accountIdentities.upsertSeen, {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
          identityHash: freeQuotaSubject,
          userId: event.data.id,
        });
      }
      captureUserSignedUp({
        user: event.data,
        workosEventId: event.id,
        workosEventCreatedAt: event.createdAt,
      });
    } else if (event.event === "authentication.email_verification_succeeded") {
      if (!event.data.userId) {
        logger.warn("Ignored WorkOS email verification without a user ID", {
          event: "workos.email_verification_missing_user_id",
          workos_event_id: event.id,
          service: "hackerai-web",
          route: "/api/workos/webhook",
        });
      } else {
        captureUserEmailVerified({
          userId: event.data.userId,
          workosEventId: event.id,
          workosEventCreatedAt: event.createdAt,
        });
      }
    }
  } catch (error) {
    console.error(
      `[WorkOS Webhook] Handler failed for event ${event.id} (${event.event}):`,
      error,
    );
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  after(() => phLogger.flush());

  // Finalization is idempotent. Retry only this marker, never the handler or
  // arbitrary mutations: a reset can arrive after Convex committed the write.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let outcome: "recovered" | "exhausted" | "not_retryable";
    let transportCode: string | undefined;
    try {
      await getConvexClient().mutation(
        api.extraUsage.finalizeWebhookProcessing,
        {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
          eventId: event.id,
        },
      );
      if (attempt === 1) break;
      outcome = "recovered";
    } catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (
          typeof code === "string" &&
          [
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
            "EAI_AGAIN",
            "UND_ERR_CONNECT_TIMEOUT",
            "UND_ERR_HEADERS_TIMEOUT",
            "UND_ERR_BODY_TIMEOUT",
            "UND_ERR_SOCKET",
          ].includes(code)
        ) {
          transportCode = code;
          break;
        }
        cause = cause.cause;
      }
      if (transportCode && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
        continue;
      }
      outcome = transportCode ? "exhausted" : "not_retryable";
    }
    logger.warn("WorkOS webhook finalization outcome", {
      event: "workos.webhook_finalization",
      workos_event_id: event.id,
      request_id: req.headers.get("x-vercel-id") ?? "unknown",
      service: "hackerai-web",
      route: "/api/workos/webhook",
      attempts: attempt,
      outcome,
      ...(transportCode ? { transport_code: transportCode } : {}),
    });
    break;
  }

  return NextResponse.json({ received: true });
}
