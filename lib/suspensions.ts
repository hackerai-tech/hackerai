import "server-only";

import { api } from "@/convex/_generated/api";
import { ChatSDKError } from "@/lib/errors";
import { getConvexClient } from "@/lib/db/convex-client";
import { getSuspensionMessage } from "@/lib/suspensionMessage";

const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

export async function getActiveSuspensionForUser(userId: string) {
  return await getConvexClient().query(api.userSuspensions.getActiveByUser, {
    serviceKey,
    userId,
  });
}

export async function getActiveFraudDisputeSuspensionForUser(userId: string) {
  return await getConvexClient().query(
    api.userSuspensions.getActiveFraudDisputeByUser,
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

export async function assertUserCanAccessChatHistory(userId: string) {
  const suspension = await getActiveFraudDisputeSuspensionForUser(userId);
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
