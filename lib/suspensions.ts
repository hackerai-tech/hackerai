import "server-only";
import { setTimeout as delay } from "node:timers/promises";

import { api } from "@/convex/_generated/api";
import { ChatSDKError } from "@/lib/errors";
import { getConvexClient } from "@/lib/db/convex-client";
import { getSuspensionMessage } from "@/lib/suspensionMessage";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";

const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

export async function getActiveSuspensionForUser(userId: string) {
  return await getConvexClient().query(api.userSuspensions.getActiveByUser, {
    serviceKey,
    userId,
  });
}

export async function hasActiveSuspensionForUser(userId: string) {
  const suspension = await getActiveSuspensionForUser(userId);
  return suspension?.status === "active";
}

export async function getActiveChatAccessBlockForUser(userId: string) {
  return await getConvexClient().query(
    api.userSuspensions.getActiveChatAccessBlockByUser,
    {
      serviceKey,
      userId,
    },
  );
}

/**
 * Fails closed unless the suspension read succeeds and permits access.
 * Web preflight may retry one native fetch failure before any writes; repeated
 * worker checks retain their single-read budget. Honors a supplied abort signal
 * when the runtime delivers it, without changing platform cancellation settings.
 */
export async function assertUserCanMakeCostIncurringRequest(
  userId: string,
  options?: { retryNetworkFailure?: boolean; signal?: AbortSignal },
) {
  let suspension;
  try {
    suspension = await getActiveSuspensionForUser(userId);
    options?.signal?.throwIfAborted();
  } catch (error) {
    // Only web preflight opts in, once before any writes or task creation.
    // Workers recheck this gate after waits/tools; they must not replenish a
    // retry budget on every check. Never retry an application/auth rejection.
    if (
      !options?.retryNetworkFailure ||
      !(error instanceof TypeError) ||
      error.message !== "fetch failed"
    ) {
      throw error;
    }
    options.signal?.throwIfAborted();
    const fields = {
      user_id: userId,
      reason: "network_fetch_failed",
      retry_limit: 1,
    };
    console.warn(
      JSON.stringify({ event: "suspension_gate_read_retry", ...fields }),
    );
    try {
      await delay(250, undefined, { signal: options.signal });
      options.signal?.throwIfAborted();
      suspension = await getActiveSuspensionForUser(userId);
      options.signal?.throwIfAborted();
      console.info(
        JSON.stringify({
          event: "suspension_gate_read_retry_result",
          ...fields,
          outcome: "read_succeeded",
          access: suspension ? "blocked" : "allowed",
        }),
      );
    } catch (retryError) {
      console.warn(
        JSON.stringify({
          event: "suspension_gate_read_retry_result",
          ...fields,
          outcome: options.signal?.aborted ? "canceled" : "exhausted",
        }),
      );
      throw retryError;
    }
  }
  if (!suspension) return;

  throw new ChatSDKError(
    "forbidden:chat",
    getSuspensionMessage(`${suspension.category}:${suspension.source_id}`),
    {
      suspensionCategory: suspension.category,
      suspensionSource: suspension.source,
    },
  );
}

export async function assertUserCanStartBillingTransaction(userId: string) {
  if (!(await hasActiveSuspensionForUser(userId))) return;

  throw new Error(BILLING_ERRORS.accountSuspended);
}

export async function assertUserCanAccessChatHistory(userId: string) {
  const suspension = await getActiveChatAccessBlockForUser(userId);
  if (!suspension) return;

  throw new ChatSDKError(
    "forbidden:chat",
    getSuspensionMessage(`${suspension.category}:${suspension.source_id}`),
    {
      suspensionCategory: suspension.category,
      suspensionSource: suspension.source,
    },
  );
}
