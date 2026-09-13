import { ConvexError } from "convex/values";

import { getSuspensionMessage } from "../../lib/suspensionMessage";
import { getActiveChatAccessBlockingSuspension } from "./chatAccessSuspensions";

export const CHAT_ACCESS_SUSPENDED_CODE = "CHAT_ACCESS_SUSPENDED";

export async function isUserBlockedFromChatHistory(
  ctx: Parameters<typeof getActiveChatAccessBlockingSuspension>[0],
  userId: string,
): Promise<boolean> {
  return (await getActiveChatAccessBlockingSuspension(ctx, userId)) !== null;
}

export async function assertUserCanAccessChatHistory(
  ctx: Parameters<typeof getActiveChatAccessBlockingSuspension>[0],
  userId: string,
): Promise<void> {
  const suspension = await getActiveChatAccessBlockingSuspension(ctx, userId);
  if (!suspension) return;

  throw new ConvexError({
    code: CHAT_ACCESS_SUSPENDED_CODE,
    message: getSuspensionMessage(
      `${suspension.category}:${suspension.source_id}`,
    ),
    suspensionCategory: suspension.category,
    suspensionSource: suspension.source,
  });
}
