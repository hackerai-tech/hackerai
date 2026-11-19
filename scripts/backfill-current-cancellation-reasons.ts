#!/usr/bin/env tsx

import { parseArgs } from "node:util";
import { config } from "dotenv";
import Stripe from "stripe";
import { api } from "../convex/_generated/api";
import { createServiceConvexClient } from "../lib/db/service-client";
import { subscriptionPauseFromMetadata } from "../lib/billing/retention-offers";

/**
 * Reconcile one bounded history page after verifying the environment/account mapping.
 * Dry-run by default; uncertain Stripe matches and changed candidates are skipped.
 * Never print customer feedback or select credentials from an implicit environment.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string" },
      "expect-convex-url": { type: "string" },
      "expect-stripe-account": { type: "string" },
      "stripe-mode": { type: "string" },
      cursor: { type: "string" },
      execute: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: tsx scripts/backfill-current-cancellation-reasons.ts --env-file <verified-env-file> --expect-convex-url <url> --expect-stripe-account <acct_id> --stripe-mode test|live [--cursor <cursor>] [--execute]\nProcesses one page of at most 100 history rows. Dry-run by default. Prints only counts and the next cursor. Repeat with that cursor until isDone is true. Use current_cancellation_reasons for current feedback; the original tables remain history.",
    );
    return;
  }
  if (
    !values["env-file"] ||
    !values["expect-convex-url"] ||
    !values["expect-stripe-account"] ||
    !["test", "live"].includes(values["stripe-mode"] ?? "")
  )
    throw new Error("Explicit environment identity is required");
  // Use one explicit file, not inherited or mixed credentials.
  const loaded = config({
    path: values["env-file"],
    processEnv: {},
    quiet: true,
  });
  const env = loaded.parsed;
  if (loaded.error || !env) throw new Error("Could not read environment");
  const url = env.NEXT_PUBLIC_CONVEX_URL;
  const serviceKey = env.CONVEX_SERVICE_ROLE_KEY;
  const stripeKey = env.STRIPE_SECRET_KEY;
  if (
    url !== values["expect-convex-url"] ||
    !serviceKey ||
    !stripeKey ||
    !new RegExp(`^[sr]k_${values["stripe-mode"]}_`).test(stripeKey)
  )
    throw new Error("Environment identity mismatch");
  const stripe = new Stripe(stripeKey, { maxNetworkRetries: 0 });
  const account = await stripe.accounts.retrieveCurrent();
  if (account.id !== values["expect-stripe-account"])
    throw new Error("Stripe account mismatch");
  const convex = createServiceConvexClient(url);
  const result = await convex.query(
    api.cancellationReasons.getCurrentReasonBackfillPage,
    {
      serviceKey,
      paginationOpts: { cursor: values.cursor ?? null, numItems: 100 },
    },
  );
  const counts = {
    candidates: result.page.length,
    current: 0,
    reversed: 0,
    uncertain: 0,
    applied: 0,
    stale: 0,
  };
  for (const candidate of result.page) {
    const subscription = await stripe.subscriptions.retrieve(
      candidate.subscriptionId,
    );
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
    if (
      customerId !== candidate.customerId ||
      subscription.livemode !== (values["stripe-mode"] === "live")
    )
      throw new Error("Subscription identity mismatch");
    const canceled =
      subscription.cancel_at_period_end || subscription.status === "canceled";
    const pause = subscriptionPauseFromMetadata(subscription.metadata) !== null;
    const matchingAttempt =
      subscription.metadata.hackerai_cancellation_reason_id === candidate.id;
    const matchingLegacyFeedback =
      !subscription.metadata.hackerai_cancellation_reason_id &&
      subscription.cancellation_details?.comment?.trim() ===
        candidate.reasonDetails;
    // Never guess which historic survey belongs to a different Stripe decision.
    if (
      canceled &&
      !pause &&
      ((!matchingAttempt && !matchingLegacyFeedback) ||
        subscription.cancellation_details?.reason !== "cancellation_requested")
    ) {
      counts.uncertain++;
      continue;
    }
    const cancellationActive = canceled && !pause;
    counts[cancellationActive ? "current" : "reversed"]++;
    if (values.execute) {
      const mutation = await convex.mutation(
        api.cancellationReasons.reconcileCurrentCancellationReason,
        {
          serviceKey,
          cancellationReasonId: candidate.id,
          expectedUpdatedAt: candidate.updatedAt,
          cancellationActive,
        },
      );
      counts[mutation.applied ? "applied" : "stale"]++;
    }
  }
  console.log(
    JSON.stringify({
      mode: values.execute ? "execute" : "dry-run",
      ...counts,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    }),
  );
}

main().catch(() => {
  // Stripe errors may contain customer information; never print the raw error.
  console.error(
    "Reconciliation stopped. Verify the explicit environment, account, and service access before retrying this page. Prior successful writes are idempotent.",
  );
  process.exitCode = 1;
});
