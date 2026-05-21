import { after, NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import type { Event } from "@workos-inc/node";
import { api } from "@/convex/_generated/api";
import { workos } from "@/app/api/workos";
import { captureUserSignedUp } from "@/lib/analytics/user-signup";
import { phLogger } from "@/lib/posthog/server";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export const runtime = "nodejs";

async function alreadyProcessed(eventId: string): Promise<boolean> {
  const result = await convex.mutation(api.extraUsage.checkAndMarkWebhook, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    eventId,
    checkOnly: true,
  });

  return result.alreadyProcessed;
}

async function markProcessed(eventId: string): Promise<void> {
  await convex.mutation(api.extraUsage.checkAndMarkWebhook, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    eventId,
  });
}

/**
 * POST /api/workos/webhook
 * Handles WorkOS user lifecycle events for acquisition analytics.
 *
 * Configure in WorkOS Dashboard:
 * - Endpoint URL: https://your-domain.com/api/workos/webhook
 * - Events: user.created
 */
export async function POST(req: NextRequest) {
  const signature = req.headers.get("workos-signature");

  if (!signature) {
    console.error("[WorkOS Webhook] Missing workos-signature header");
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

  try {
    if (await alreadyProcessed(event.id)) {
      console.log(`[WorkOS Webhook] Event ${event.id} already processed`);
      return NextResponse.json({ received: true });
    }
  } catch (error) {
    console.error("[WorkOS Webhook] Idempotency check failed:", error);
    return NextResponse.json(
      { error: "Failed to check idempotency" },
      { status: 500 },
    );
  }

  if (event.event === "user.created") {
    captureUserSignedUp({
      user: event.data,
      workosEventId: event.id,
      workosEventCreatedAt: event.createdAt,
    });
  }

  after(() => phLogger.flush());

  try {
    await markProcessed(event.id);
  } catch (error) {
    console.error(
      `[WorkOS Webhook] Failed to mark event ${event.id} as processed:`,
      error,
    );
  }

  return NextResponse.json({ received: true });
}
