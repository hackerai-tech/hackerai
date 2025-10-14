import {
  getCancellationStatus,
  getTempCancellationStatus,
} from "@/lib/db/actions";
import type { ChatMode } from "@/types";

type PollOptions = {
  chatId: string;
  isTemporary: boolean;
  abortController: AbortController;
  onStop: () => void;
  pollIntervalMs?: number;
};

type PreemptiveTimeoutOptions = {
  chatId: string;
  mode: ChatMode;
  abortController: AbortController;
  safetyBuffer?: number;
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

/**
 * Creates a pre-emptive timeout that aborts the stream before Vercel's hard timeout.
 * This ensures graceful shutdown with proper cleanup and data persistence.
 */
export const createPreemptiveTimeout = ({
  chatId,
  mode,
  abortController,
  safetyBuffer = 10,
}: PreemptiveTimeoutOptions) => {
  const maxDuration = mode === "agent" ? 500 : 120;
  const maxStreamTime = (maxDuration - safetyBuffer) * 1000;

  let isPreemptive = false;

  const timeoutId = setTimeout(() => {
    console.log(
      `[Chat ${chatId}] Pre-emptive abort triggered (${safetyBuffer}s before ${maxDuration}s timeout)`,
    );
    isPreemptive = true;
    abortController.abort();
  }, maxStreamTime);

  return {
    timeoutId,
    clear: () => clearTimeout(timeoutId),
    isPreemptive: () => isPreemptive,
  };
};
