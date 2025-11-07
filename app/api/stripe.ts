import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  // @ts-expect-error - Using Stripe beta API version
  apiVersion: "2025-09-30.clover",
});

export { stripe };
