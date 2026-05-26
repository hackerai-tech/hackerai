import { after, NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import type { Event } from "@workos-inc/node";
import { api } from "@/convex/_generated/api";
import { workos } from "@/app/api/workos";
import { captureUserSignedUp } from "@/lib/analytics/user-signup";
import { phLogger } from "@/lib/posthog/server";
import { getReferralAttribution } from "@/lib/referrals";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export const runtime = "nodejs";

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

  let claimState: "acquired" | "already_processed" | "claim_held";
  try {
    const result = await convex.mutation(
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
      const referralAttribution = await getReferralAttribution(event.data.id);
      captureUserSignedUp({
        user: event.data,
        workosEventId: event.id,
        workosEventCreatedAt: event.createdAt,
        referralAttribution,
      });
    }
  } catch (error) {
    console.error(
      `[WorkOS Webhook] Handler failed for event ${event.id} (${event.event}):`,
      error,
    );
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  after(() => phLogger.flush());

  try {
    await convex.mutation(api.extraUsage.finalizeWebhookProcessing, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      eventId: event.id,
    });
  } catch (error) {
    console.error(
      `[WorkOS Webhook] Failed to finalize event ${event.id}:`,
      error,
    );
  }

  return NextResponse.json({ received: true });
}
