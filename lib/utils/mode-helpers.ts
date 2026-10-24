import { ChatSDKError } from "@/lib/errors";
import type { ChatMode, SubscriptionTier } from "@/types/chat";

/** Returns true for "agent" mode. Use for shared behavior (Pro gating, tools, model selection, file handling). */
export const isAgentMode = (mode: ChatMode): boolean => mode === "agent";

/**
 * Paid plans are Agent-only. Share this guard between API access checks and
 * model selection so no caller can restore the removed paid Ask path.
 */
export function assertChatModeAccess(args: {
  mode: unknown;
  subscription: SubscriptionTier;
}): void {
  if (args.mode !== "ask" && args.mode !== "agent") {
    throw new ChatSDKError("bad_request:api", "Invalid chat mode.");
  }

  if (args.mode !== "ask" || args.subscription === "free") return;

  throw new ChatSDKError(
    "forbidden:chat",
    "Paid plans use Agent mode. Ask mode is only available on the free plan.",
  );
}
