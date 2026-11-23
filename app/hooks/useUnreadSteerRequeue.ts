import { useEffect, useRef, useState } from "react";
import { useCommittedRef } from "./useLatestRef";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

// Steers from an earlier visit (for example, a closed tab) come back held,
// so reopening a chat never sends an old message without the user's action.
const PAGE_SESSION_STARTED_AT = Date.now();
const MAX_WITHDRAW_RETRIES = 5;
const WITHDRAW_RETRY_BASE_MS = 1_000;

export type PendingAgentSteer = {
  id: string;
  text: string;
  runId: string;
  createdAt: number;
  claimed: boolean;
};

/**
 * Pending steers for this chat. Once no run is active, each is withdrawn; the
 * withdrawal races the run's claim atomically. A steer the run never claimed
 * returns to the queue. One it claimed is kept only by the saved transcript:
 * if the transcript shows it, it is dropped; otherwise it returns to the
 * queue. Claimed steers therefore wait until the transcript has loaded.
 */
export function useUnreadSteerRequeue({
  chatId,
  enabled,
  runActive,
  isInTranscript,
  transcriptReady,
  onRequeue,
}: {
  chatId: string;
  enabled: boolean;
  runActive: boolean;
  isInTranscript: (steerId: string) => boolean;
  transcriptReady: boolean;
  onRequeue: (
    chatId: string,
    steers: Array<{ text: string; timestamp: number }>,
    hold: boolean,
  ) => void;
}): {
  pendingSteers: PendingAgentSteer[];
  /** Queued messages must wait: unread steers go back ahead of them. */
  recovering: boolean;
} {
  const pending = useQuery(
    api.agentSteers.listPending,
    enabled ? { chatId } : "skip",
  );
  const withdraw = useMutation(api.agentSteers.withdraw);
  const withdrawing = useRef(new Set<string>());
  const [inFlight, setInFlight] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  // After repeated failures, stop holding the queue for steers still listed.
  const [gaveUp, setGaveUp] = useState(false);
  const retryAttempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const onRequeueRef = useCommittedRef(onRequeue);
  const isInTranscriptRef = useCommittedRef(isInTranscript);

  useEffect(() => () => clearTimeout(retryTimer.current), []);

  useEffect(() => {
    if (!enabled || runActive || !pending?.length) return;
    const unread = pending.filter(
      (steer) =>
        !withdrawing.current.has(steer.id) &&
        (transcriptReady || !steer.claimed),
    );
    if (!unread.length) return;
    for (const steer of unread) withdrawing.current.add(steer.id);
    void (async () => {
      setInFlight((count) => count + 1);
      const restored: Array<{ text: string; timestamp: number }> = [];
      let failed = false;
      for (const steer of unread) {
        try {
          const result = await withdraw({ chatId, id: steer.id });
          if (
            result.outcome === "withdrawn" &&
            !isInTranscriptRef.current(steer.id)
          )
            restored.push({ text: result.text, timestamp: steer.createdAt });
        } catch {
          // Still pending; a bounded retry runs even if nothing else changes.
          withdrawing.current.delete(steer.id);
          failed = true;
        }
      }
      onRequeueRef.current(
        chatId,
        restored,
        restored.some((steer) => steer.timestamp < PAGE_SESSION_STARTED_AT),
      );
      if (!failed) {
        retryAttempts.current = 0;
        setGaveUp(false);
      } else if (retryAttempts.current < MAX_WITHDRAW_RETRIES) {
        const delay = WITHDRAW_RETRY_BASE_MS * 2 ** retryAttempts.current++;
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(
          () => setRetryTick((tick) => tick + 1),
          delay,
        );
      } else {
        setGaveUp(true);
      }
      setInFlight((count) => count - 1);
    })();
  }, [
    chatId,
    enabled,
    isInTranscriptRef,
    onRequeueRef,
    pending,
    retryTick,
    runActive,
    transcriptReady,
    withdraw,
  ]);

  return {
    pendingSteers: enabled ? (pending ?? []) : [],
    recovering:
      enabled &&
      !runActive &&
      (pending === undefined ||
        inFlight > 0 ||
        (pending.length > 0 && !gaveUp)),
  };
}
