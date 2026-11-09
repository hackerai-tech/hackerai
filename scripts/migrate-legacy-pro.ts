/** Operator-only; no automatic environment loading and no live actions on deploy. */
import Stripe from "stripe";
import { z } from "zod";
import { readFile, mkdir, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  applyLegacyProMigration,
  LegacyProMigrationValidationError,
  legacyProManifestSchema,
  validateMigrationPrices,
  validateMigrationSubscription,
  validateMigrationCustomer,
} from "../lib/billing/legacy-pro-migration";

async function main() {
  const [manifestPath, ...options] = process.argv.slice(2);
  if (!manifestPath || options.some((option) => option !== "--apply"))
    throw new LegacyProMigrationValidationError(
      "Usage: tsx scripts/migrate-legacy-pro.ts manifest.json [--apply]",
    );
  const apply = options.includes("--apply");
  const manifest = legacyProManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const key = process.env.STRIPE_SECRET_KEY;
  if (
    !key ||
    !/^(sk|rk)_(test|live)_/.test(key) ||
    key.includes("_live_") !== manifest.livemode
  )
    throw new LegacyProMigrationValidationError(
      "Explicit Stripe key and manifest mode must match",
    );
  const stripe = new Stripe(key, {
    maxNetworkRetries: 0,
    apiVersion: "2026-08-26.dahlia",
  });
  const account = await stripe.accounts.retrieve(null);
  if (account.id !== manifest.accountId)
    throw new LegacyProMigrationValidationError("Stripe account mismatch");
  const source = await stripe.prices.retrieve(manifest.sourcePriceId);
  const target = await stripe.prices.retrieve(manifest.targetPriceId);
  validateMigrationPrices(manifest, source, target);
  // Validate the entire allowlist before the first write; refresh each entry again on apply.
  for (const entry of manifest.entries) {
    const subscription = await stripe.subscriptions.retrieve(
      entry.subscriptionId,
    );
    validateMigrationSubscription(
      manifest,
      entry,
      subscription,
      Math.floor(Date.now() / 1000),
    );
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
    validateMigrationCustomer(await stripe.customers.retrieve(customerId));
  }
  console.log(
    JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      accountId: account.id,
      livemode: manifest.livemode,
      subscriptions: manifest.entries.map((e) => ({
        subscriptionId: e.subscriptionId,
        effectiveAt: e.effectiveAt,
      })),
    }),
  );
  if (!apply) return;
  const directory = process.env.LEGACY_PRO_MIGRATION_RECEIPTS_DIR;
  if (!directory)
    throw new LegacyProMigrationValidationError(
      "Set LEGACY_PRO_MIGRATION_RECEIPTS_DIR to a persistent private directory",
    );
  await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
  for (const entry of manifest.entries) {
    // Existence means attempted, including unknown outcomes. Never overwrite or auto-replay.
    const receipt = await open(
      join(
        resolve(directory),
        `${manifest.accountId}-${entry.subscriptionId}.jsonl`,
      ),
      "wx",
      0o600,
    );
    try {
      await receipt.writeFile(
        JSON.stringify({
          state: "attempting",
          manifest: { ...manifest, entries: [entry] },
        }) + "\n",
      );
      await receipt.sync();
      const parent = await open(resolve(directory), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      const result = await applyLegacyProMigration(
        stripe,
        manifest,
        entry,
        Math.floor(Date.now() / 1000),
      );
      await receipt.writeFile(
        JSON.stringify({ state: "scheduled", ...result }) + "\n",
      );
      await receipt.sync();
      console.log(JSON.stringify(result));
    } finally {
      await receipt.close();
    }
  }
}
main().catch((error: unknown) => {
  if (error instanceof LegacyProMigrationValidationError) {
    console.error(error.message);
  } else if (error instanceof z.ZodError) {
    console.error(
      JSON.stringify({
        invalidFields: error.issues.map((issue) => issue.path.join(".")),
      }),
    );
  } else if (error instanceof Stripe.errors.StripeError) {
    console.error(
      JSON.stringify({ type: error.type, requestId: error.requestId }),
    );
  } else if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    ["EEXIST", "ENOENT", "EACCES", "ENOSPC"].includes(error.code)
  ) {
    console.error(JSON.stringify({ fileError: error.code }));
  }
  // SDK errors can include request headers/customer data. Keep diagnostics bounded.
  console.error(
    "Migration stopped. Check manifest, account/mode, eligibility and private receipts. If apply started, reconcile Stripe read-only before any retry. No automatic rollback was attempted.",
  );
  process.exitCode = 1;
});
