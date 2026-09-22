import "server-only";

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

export async function assertUserCanMakeCostIncurringRequest(userId: string) {
  const suspension = await getActiveSuspensionForUser(userId);
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
