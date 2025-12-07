/**
 * Attach Failing Card Script
 *
 * This script attaches a Stripe test card that will FAIL when charged to a customer.
 * It's used for testing payment failure scenarios during subscription upgrades.
 *
 * How it works:
 * 1. Finds the Stripe customer by email
 * 2. Removes ALL existing payment methods (so there's no fallback)
 * 3. Attaches tok_visa_chargeCustomerFail - a special Stripe test token
 * 4. Sets it as the default payment method
 *
 * The tok_visa_chargeCustomerFail token behavior:
 * - Attaches to customer successfully
 * - Passes initial validation
 * - FAILS when an actual charge is attempted
 *
 * Use case:
 * Test that subscription upgrades with `payment_behavior: "pending_if_incomplete"`
 * correctly keep the user on their current plan when payment fails, rather than
 * leaving them in a broken state.
 *
 * Usage:
 *   pnpm stripe:attach-failing-card <customer-email>
 *
 * Example:
 *   pnpm stripe:attach-failing-card pro1@hackerai.com
 *
 * After running:
 *   1. Log in as the user in the app
 *   2. Try to upgrade (e.g., Pro → Ultra)
 *   3. Payment should fail and user should remain on their current plan
 *
 * @see https://docs.stripe.com/testing#cards - Stripe test tokens documentation
 */

import Stripe from "stripe";
import * as dotenv from "dotenv";
import * as path from "path";
import chalk from "chalk";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  typescript: true,
});

async function attachFailingCard(customerEmail: string) {
  console.log(
    chalk.bold.blue(`\n🔧 Attaching failing card to ${customerEmail}\n`),
  );

  // 1. Find customer
  const customers = await stripe.customers.list({
    email: customerEmail,
    limit: 1,
  });
  if (customers.data.length === 0) {
    console.log(chalk.red("❌ Customer not found"));
    return;
  }
  const customer = customers.data[0];
  console.log(chalk.green(`✓ Found customer: ${customer.id}`));

  // 2. Remove all existing payment methods
  console.log(chalk.cyan("\n📝 Removing existing payment methods..."));
  const existingPMs = await stripe.paymentMethods.list({
    customer: customer.id,
    type: "card",
  });
  for (const pm of existingPMs.data) {
    await stripe.paymentMethods.detach(pm.id);
    console.log(chalk.gray(`   Removed: ${pm.id}`));
  }
  console.log(
    chalk.green(
      `✓ Removed ${existingPMs.data.length} existing payment method(s)`,
    ),
  );

  // 3. Attach tok_visa_chargeCustomerFail - attaches OK but fails on charge
  console.log(
    chalk.cyan("\n📝 Attaching test card that will fail on charge..."),
  );

  const paymentMethod = await stripe.paymentMethods.create({
    type: "card",
    card: { token: "tok_visa_chargeCustomerFail" },
  });

  await stripe.paymentMethods.attach(paymentMethod.id, {
    customer: customer.id,
  });

  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });

  console.log(chalk.green(`✓ Attached payment method: ${paymentMethod.id}`));
  console.log(chalk.green(`✓ Set as default (only) payment method`));

  console.log(chalk.bold.yellow("\n⚠️  This card will FAIL when charged!"));
  console.log(chalk.gray("   Token: tok_visa_chargeCustomerFail"));
  console.log(
    chalk.gray("   Behavior: Attaches OK, fails when customer is charged"),
  );

  console.log(chalk.bold.green("\n✨ Done! Now try upgrading in the UI.\n"));
}

// Get email from command line
const email = process.argv[2];
if (!email) {
  console.log(
    chalk.red("Usage: npx tsx scripts/attach-failing-card.ts <customer-email>"),
  );
  console.log(
    chalk.gray(
      "Example: npx tsx scripts/attach-failing-card.ts pro1@hackerai.com",
    ),
  );
  process.exit(1);
}

attachFailingCard(email).catch((error) => {
  console.error(chalk.red("\n❌ Fatal error:"), error);
  process.exit(1);
});
