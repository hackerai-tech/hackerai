import { useEffect, useRef } from "react";
import { useCommittedRef } from "./useLatestRef";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

// Steers from an earlier visit (for example, a closed tab) come back held,
// so reopening a chat never sends an old message without the user's action.
const PAGE_SESSION_STARTED_AT = Date.now();

export type PendingAgentSteer = {
  id: string;
  text: string;
  runId: string;
  createdAt: number;
};

/**
 * Pending steers for this chat. Once no run is active, unread steers are
 * withdrawn and returned to the front of the queue; the withdrawal races the
 * run's claim atomically, so each steer is either read or queued, never both.
 */
export function useUnreadSteerRequeue({
  chatId,
  enabled,
  runActive,
  onRequeue,
}: {
  chatId: string;
  enabled: boolean;
  runActive: boolean;
  onRequeue: (
    chatId: string,
    steers: Array<{ text: string; timestamp: number }>,
    hold: boolean,
  ) => void;
}): PendingAgentSteer[] {
  const pending = useQuery(
    api.agentSteers.listPending,
    enabled ? { chatId } : "skip",
  );
  const withdraw = useMutation(api.agentSteers.withdraw);
  const withdrawing = useRef(new Set<string>());
  const onRequeueRef = useCommittedRef(onRequeue);

  useEffect(() => {
    if (!enabled || runActive || !pending?.length) return;
    const unread = pending.filter(
      (steer) => !withdrawing.current.has(steer.id),
    );
    if (!unread.length) return;
    for (const steer of unread) withdrawing.current.add(steer.id);
    void (async () => {
      const restored: Array<{ text: string; timestamp: number }> = [];
      for (const steer of unread) {
        try {
          const result = await withdraw({ chatId, id: steer.id });
          if (result.outcome === "withdrawn")
            restored.push({ text: result.text, timestamp: steer.createdAt });
        } catch {
          // Still pending; a later snapshot retries it.
          withdrawing.current.delete(steer.id);
        }
      }
      onRequeueRef.current(
        chatId,
        restored,
        restored.some((steer) => steer.timestamp < PAGE_SESSION_STARTED_AT),
      );
    })();
  }, [chatId, enabled, onRequeueRef, pending, runActive, withdraw]);

  return enabled ? (pending ?? []) : [];
}
