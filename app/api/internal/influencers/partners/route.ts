import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { stripe } from "@/app/api/stripe";
import { getConvexClient, getConvexUrl } from "@/lib/db/convex-client";
import { createFreeQuotaSubjectWithSecret } from "@/lib/auth/free-quota-subject-core";
import {
  partnerRequestSchema,
  partnerProvisioningUrl,
} from "@/lib/influencers/provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  const authorization = request.headers.get("authorization") ?? "";
  if (
    !serviceKey ||
    !timingSafeEqual(
      createHash("sha256").update(authorization).digest(),
      createHash("sha256").update(`Bearer ${serviceKey}`).digest(),
    )
  )
    return json({ error: "Unauthorized" }, 401);

  // Bound the actual stream, including requests without Content-Length.
  let raw: unknown;
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "Invalid JSON" }, 400);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return json({ error: "Request too large" }, 413);
      }
      chunks.push(value);
    }
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  } finally {
    reader.releaseLock();
  }
  const parsed = partnerRequestSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "Invalid partner request" }, 400);
  const input = parsed.data;

  try {
    if (input.targetUrl !== getConvexUrl())
      return json({ error: "Convex target mismatch" }, 409);
    const identity = createFreeQuotaSubjectWithSecret(
      input.email,
      process.env.ACCOUNT_IDENTITY_HMAC_SECRET,
    );
    if (!identity || !process.env.NEXT_PUBLIC_BASE_URL)
      return json({ error: "Partner creation unavailable" }, 503);
    const base = partnerProvisioningUrl(process.env.NEXT_PUBLIC_BASE_URL);
    const [account, balance] = await Promise.all([
      stripe.accounts.retrieveCurrent(),
      stripe.balance.retrieve(),
    ]);
    if (account.id !== input.stripeAccountId || balance.livemode !== input.live)
      return json({ error: "Stripe account or mode mismatch" }, 409);

    const convex = getConvexClient();
    const lookup = { serviceKey, code: input.code };
    let existing = await convex.query(api.influencers.getPartner, lookup);
    const reused = Boolean(existing);
    if (!existing) {
      try {
        await convex.mutation(api.influencers.createPartner, {
          ...lookup,
          name: input.name,
          contactEmail: input.email,
          ownerIdentity: identity,
          monthlyBps: input.monthlyBps,
          annualBps: input.annualBps,
        });
      } catch {
        // A lost response or concurrent retry may have committed the partner.
        existing = await convex.query(api.influencers.getPartner, lookup);
        if (!existing)
          return json({ error: "Partner creation failed; retry safely" }, 503);
      }
    }
    if (
      existing &&
      (existing.name !== input.name ||
        existing.contact_email !== input.email ||
        existing.owner_identity !== identity ||
        !existing.active ||
        existing.monthly_bps !== input.monthlyBps ||
        existing.annual_bps !== input.annualBps)
    )
      return json(
        {
          error:
            "Partner code already exists with different details or is inactive",
        },
        409,
      );

    return json(
      {
        code: input.code,
        link: new URL(`/r/${input.code}`, base.origin).toString(),
        monthlyBps: input.monthlyBps,
        annualBps: input.annualBps,
      },
      reused || existing ? 200 : 201,
    );
  } catch {
    // Provider exceptions can contain private request data; do not echo them.
    return json({ error: "Partner creation unavailable; retry safely" }, 503);
  }
}
