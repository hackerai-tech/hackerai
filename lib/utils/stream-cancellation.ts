import {
  getCancellationStatus,
  getTempCancellationStatus,
} from "@/lib/db/actions";

type PollOptions = {
  chatId: string;
  isTemporary: boolean;
  abortController: AbortController;
  onStop: () => void;
  pollIntervalMs?: number;
};

/**
 * Creates a cancellation poller that checks for stream cancellation signals
 * and triggers abort when detected. Works for both regular and temporary chats.
 */
export const createCancellationPoller = ({
  chatId,
  isTemporary,
  abortController,
  onStop,
  pollIntervalMs = 1000,
}: PollOptions) => {
  let timeoutId: NodeJS.Timeout | null = null;
  let stopped = false;

  const schedulePoll = () => {
    if (stopped || abortController.signal.aborted) return;

    timeoutId = setTimeout(async () => {
      try {
        if (isTemporary) {
          const status = await getTempCancellationStatus({ chatId });
          if (status?.canceled) {
            abortController.abort();
            return;
          }
        } else {
          const status = await getCancellationStatus({ chatId });
          if (status?.canceled_at) {
            abortController.abort();
            return;
          }
        }
      } catch {
        // Silently ignore polling errors
      } finally {
        if (!(stopped || abortController.signal.aborted)) {
          schedulePoll();
        }
      }
    }, pollIntervalMs);
  };

  // Auto-cleanup when abort is triggered
  const onAbort = () => {
    stopped = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    onStop();
  };

  abortController.signal.addEventListener("abort", onAbort, { once: true });

  // Start polling
  schedulePoll();

  return {
    stop: () => {
      stopped = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      abortController.signal.removeEventListener("abort", onAbort);
    },
  };
};
