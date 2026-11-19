import { randomUUID } from "node:crypto";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";
import { BILLING_ERRORS } from "./billing-errors";

export type SubscriptionOperation = {
  write: <T>(operation: () => Promise<T>) => Promise<T>;
};

/**
 * Coordinate cancel/keep across server instances, before reading Stripe state.
 * Busy commands are rejected, not queued with stale intent. Unknown Stripe
 * outcomes retain the durable fence: a timeout is not proof the write stopped.
 */
export async function withSubscriptionOperation<T>(
  stripeCustomerId: string,
  operation: "cancel" | "keep",
  run: (guard: SubscriptionOperation) => Promise<T>,
): Promise<T> {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey)
    throw new Error(BILLING_ERRORS.subscriptionChangeUnavailable);
  const client = getConvexClient();
  const owner = { serviceKey, stripeCustomerId, token: randomUUID() };
  let acquired: boolean;
  try {
    acquired = await client.mutation(api.billingOperations.begin, {
      ...owner,
      operation,
    });
  } catch {
    throw new Error(BILLING_ERRORS.subscriptionChangeUnavailable);
  }
  if (!acquired) throw new Error(BILLING_ERRORS.subscriptionChangeInProgress);

  let uncertainWrite = false;
  try {
    const result = await run({
      write: async (write) => {
        if (uncertainWrite)
          throw new Error(BILLING_ERRORS.subscriptionChangeInProgress);
        const owned = await client.mutation(
          api.billingOperations.startWrite,
          owner,
        );
        if (!owned)
          throw new Error(BILLING_ERRORS.subscriptionChangeInProgress);
        uncertainWrite = true;
        try {
          const result = await write();
          uncertainWrite = false;
          return result;
        } catch (error) {
          // Only a definitive Stripe rejection proves this request cannot
          // apply later. Network failures, 5xx and conflicts remain fenced.
          const stripeError = error as {
            type?: string;
            statusCode?: number;
          } | null;
          if (
            stripeError?.type?.startsWith("Stripe") &&
            stripeError.statusCode !== undefined &&
            stripeError.statusCode >= 400 &&
            stripeError.statusCode < 500 &&
            stripeError.statusCode !== 409
          )
            uncertainWrite = false;
          throw error;
        }
      },
    });
    // Even a read-only early return must still own its snapshot. A slow
    // preflight read may have outlived its claim and observed stale state.
    if (!(await client.mutation(api.billingOperations.verifyOwner, owner))) {
      throw new Error(BILLING_ERRORS.subscriptionChangeInProgress);
    }
    return result;
  } finally {
    if (uncertainWrite) {
      phLogger.error("billing_operation_requires_reconciliation", {
        stripe_customer_id: stripeCustomerId,
        operation,
      });
    } else {
      // Token-matched release is idempotent, including a lost response. Retry
      // once; preserve the confirmed result/original error if cleanup is down.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await client.mutation(api.billingOperations.finish, owner);
          break;
        } catch {
          if (attempt === 1) {
            phLogger.error("billing_operation_release_failed", {
              stripe_customer_id: stripeCustomerId,
              operation,
            });
          }
        }
      }
    }
  }
}
