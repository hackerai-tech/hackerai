#!/usr/bin/env tsx
import { writeFile } from "node:fs/promises";
import { ConvexHttpClient } from "convex/browser";
import Stripe from "stripe";
import { z } from "zod";
import { api } from "../convex/_generated/api";
import {
  partnerRequestSchema,
  partnerProvisioningUrl,
} from "../lib/influencers/provisioning";
import { flushInfluencerAnalytics } from "../lib/influencers/analytics";
import { reconcileInfluencerCustomer } from "../lib/influencers/stripe";

const requestSchema = z
  .object({
    targetUrl: z.url(),
    stripeAccountId: z.string().startsWith("acct_"),
    live: z.boolean(),
    action: z.enum([
      "create",
      "cost",
      "activate",
      "deactivate",
      "report",
      "reserve",
      "paid",
      "cancel",
      "payout",
    ]),
    code: z.string().optional(),
    name: z.string().optional(),
    email: z.email().optional(),
    amountCents: z.number().int().nonnegative().optional(),
    monthlyBps: z.number().int().min(0).max(10000).optional(),
    annualBps: z.number().int().min(0).max(10000).optional(),
    key: z.string().optional(),
    reference: z.string().optional(),
    output: z.string().optional(),
  })
  .strict();

async function main() {
  // JSON on stdin keeps contact details out of command arguments/history.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = requestSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  if (request.action === "create") {
    if (
      request.targetUrl !== process.env.NEXT_PUBLIC_CONVEX_URL ||
      !process.env.CONVEX_SERVICE_ROLE_KEY ||
      !process.env.NEXT_PUBLIC_BASE_URL
    )
      throw new Error(
        "Create requires a matching Convex URL, service credential, and verified web base URL",
      );
    const payload = partnerRequestSchema.parse({
      targetUrl: request.targetUrl,
      stripeAccountId: request.stripeAccountId,
      live: request.live,
      code: request.code,
      name: request.name,
      email: request.email,
      monthlyBps: request.monthlyBps,
      annualBps: request.annualBps,
    });
    const endpoint = partnerProvisioningUrl(process.env.NEXT_PUBLIC_BASE_URL);
    console.error(
      `Target: ${payload.targetUrl}; web ${endpoint.origin}; Stripe ${payload.stripeAccountId}; ${payload.live ? "LIVE" : "TEST"}`,
    );
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CONVEX_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw new Error(
        `Partner creation returned HTTP ${response.status}; verify deployment, credentials, target, and existing partner details before retrying`,
      );
    const result = z
      .object({ code: z.string(), link: z.url() })
      .parse(await response.json());
    if (
      result.code !== payload.code ||
      result.link !== new URL(`/r/${payload.code}`, endpoint.origin).toString()
    )
      throw new Error("Partner response did not match the requested link");
    console.log(result.link);
    return;
  }
  if (
    request.targetUrl !== process.env.NEXT_PUBLIC_CONVEX_URL ||
    !process.env.CONVEX_SERVICE_ROLE_KEY ||
    !process.env.STRIPE_SECRET_KEY
  ) {
    throw new Error(
      "Target URL must match the configured Convex URL; service credentials are required",
    );
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const account = await stripe.accounts.retrieveCurrent();
  const balance = await stripe.balance.retrieve();
  if (
    account.id !== request.stripeAccountId ||
    balance.livemode !== request.live
  )
    throw new Error(
      "Stripe account or mode does not match the requested target",
    );
  const convex = new ConvexHttpClient(request.targetUrl);
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  console.error(
    `Target: ${request.targetUrl}; Stripe ${account.id}; ${request.live ? "LIVE" : "TEST"}`,
  );
  if (["paid", "cancel", "payout"].includes(request.action)) {
    if (!request.key) throw new Error("Payout key is required");
    const payout =
      request.action === "payout"
        ? await convex.query(api.influencers.getPayout, {
            serviceKey,
            key: request.key,
          })
        : await convex.mutation(api.influencers.finishPayout, {
            serviceKey,
            key: request.key,
            action: request.action === "paid" ? "paid" : "cancel",
            ...(request.reference ? { reference: request.reference } : {}),
          });
    console.log(JSON.stringify(payout, null, 2));
    return;
  }
  if (!request.code) throw new Error("Partner code is required");
  if (request.action === "cost") {
    if (request.amountCents === undefined)
      throw new Error("Cumulative sponsorship amount in USD cents is required");
    await convex.mutation(api.influencerAnalytics.setSponsorshipCost, {
      serviceKey,
      code: request.code,
      amountCents: request.amountCents,
    });
    await flushInfluencerAnalytics(convex);
    console.log("Sponsorship cost recorded; no money transferred");
    return;
  }
  if (request.action === "activate" || request.action === "deactivate") {
    await convex.mutation(api.influencers.setActive, {
      serviceKey,
      code: request.code,
      active: request.action === "activate",
    });
    console.log(request.action);
    return;
  }
  const partner = await convex.query(api.influencers.getPartner, {
    serviceKey,
    code: request.code,
  });
  if (!partner) throw new Error("Partner not found");
  let cursor: string | null = null;
  let signups = 0;
  do {
    const page: {
      page: import("../convex/_generated/dataModel").Doc<"influencer_attributions">[];
      isDone: boolean;
      continueCursor: string;
    } = await convex.query(api.influencers.listAttributions, {
      serviceKey,
      partnerId: partner._id,
      paginationOpts: { cursor, numItems: 100 },
    });
    signups += page.page.length;
    for (const attribution of page.page) {
      if (attribution.customer_id)
        await reconcileInfluencerCustomer(
          stripe,
          convex,
          attribution.customer_id,
        );
    }
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
  await flushInfluencerAnalytics(convex);
  if (request.action === "reserve") {
    if (!request.key) throw new Error("A unique payout key is required");
    const payout = await convex.mutation(api.influencers.reservePayout, {
      serviceKey,
      partnerId: partner._id,
      key: request.key,
    });
    console.log(JSON.stringify(payout, null, 2));
    console.error(
      payout.status === "paid"
        ? "This payout is already recorded as paid. Do not transfer again."
        : payout.status === "canceled"
          ? "This payout was canceled. Use a new key for another payout."
          : "Reservation only; this command sends no money. Check the external payment provider for this payout key before transferring once, then record the external reference with the paid action.",
    );
    return;
  }
  const invoices = [];
  do {
    const page = await convex.query(api.influencers.listInvoices, {
      serviceKey,
      partnerId: partner._id,
      paginationOpts: { cursor, numItems: 100 },
    });
    invoices.push(...page.page);
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
  const now = Date.now();
  const report = {
    code: partner.code,
    name: partner.name,
    contactEmail: partner.contact_email,
    monthlyBps: partner.monthly_bps,
    annualBps: partner.annual_bps,
    signups,
    linkOpens: partner.link_opens ?? 0,
    sponsorshipCostCents: partner.sponsorship_cost_cents ?? 0,
    netRevenueCents: invoices
      .filter((row) => row.currency === "usd")
      .reduce((sum, row) => sum + row.net_cents, 0),
    holdingCents: invoices
      .filter(
        (row) =>
          row.currency === "usd" &&
          !row.review_reason &&
          !row.payout_id &&
          row.eligible_at > now,
      )
      .reduce(
        (sum, row) => sum + Math.max(0, row.earned_cents - row.paid_cents),
        0,
      ),
    eligibleBalanceCents: invoices
      .filter(
        (row) =>
          row.currency === "usd" &&
          !row.review_reason &&
          !row.payout_id &&
          (row.eligible_at <= now || row.earned_cents < row.paid_cents),
      )
      .reduce((sum, row) => sum + row.earned_cents - row.paid_cents, 0),
    payingCustomers: new Set(invoices.map((row) => row.customer_id)).size,
    currency: "usd",
    generatedAt: new Date(now).toISOString(),
    earnedCents: invoices
      .filter((row) => row.currency === "usd")
      .reduce((sum, row) => sum + row.earned_cents, 0),
    paidCents: invoices
      .filter((row) => row.currency === "usd")
      .reduce((sum, row) => sum + row.paid_cents, 0),
    invoices: invoices.map((row) => ({
      invoiceId: row.invoice_id,
      customerId: row.customer_id,
      subscriptionId: row.subscription_id,
      currency: row.currency,
      interval: row.interval,
      paidAt: new Date(row.paid_at).toISOString(),
      eligibleAt: new Date(row.eligible_at).toISOString(),
      grossCents: row.gross_cents,
      netCents: row.net_cents,
      rateBps: row.rate_bps,
      earnedCents: row.earned_cents,
      paidCents: row.paid_cents,
      balanceCents: row.earned_cents - row.paid_cents,
      status: row.review_reason
        ? "review"
        : row.payout_id
          ? "reserved"
          : row.earned_cents < row.paid_cents
            ? "clawback"
            : row.earned_cents === row.paid_cents
              ? "settled"
              : row.eligible_at <= now
                ? "eligible"
                : "holding",
      reviewReason: row.review_reason,
    })),
  };
  const output = JSON.stringify(report, null, 2);
  if (request.output) {
    await writeFile(request.output, output + "\n", { mode: 0o600, flag: "wx" });
    console.log(
      `Wrote ${invoices.length} invoice records to ${request.output}`,
    );
  } else console.log(output);
}

main().catch(() => {
  // SDK/validation errors may contain arguments or personal information.
  console.error(
    "Influencer operation failed. Check the request, target identity, and service-side logs. No automatic transfer was attempted.",
  );
  process.exitCode = 1;
});
