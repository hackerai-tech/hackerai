import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { createAgentSteerInbox } from "@/lib/chat/agent-steer";

// A slow read delays the next model step; an unread steer is queued later.
const CLAIM_TIMEOUT_MS = 2_000;

/** The parent Agent run's inbox for follow-ups sent while it works. */
export function createRunSteerInbox({
  userId,
  chatId,
  runId,
  onError,
}: {
  userId: string;
  chatId: string;
  runId: string;
  onError?: (error: unknown) => void;
}) {
  return createAgentSteerInbox({
    claim: () =>
      getConvexClient(AbortSignal.timeout(CLAIM_TIMEOUT_MS)).mutation(
        api.agentSteers.claimForBackend,
        {
          serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
          userId,
          chatId,
          runId,
        },
      ),
    onError,
  });
}
