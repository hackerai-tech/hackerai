import {
  getCancellationStatus,
  getTempCancellationStatus,
} from "@/lib/db/actions";
import type { ChatMode } from "@/types";
import {
  createRedisSubscriber,
  getCancelChannel,
} from "@/lib/utils/redis-pubsub";
import { createClient } from "redis";

// Use the same type as redis-pubsub.ts
type RedisClient = ReturnType<typeof createClient>;

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

type CancellationSubscriberResult = {
  stop: () => Promise<void>;
  isUsingPubSub: boolean;
};

/**
 * Creates a cancellation poller that checks for stream cancellation signals
 * and triggers abort when detected. Works for both regular and temporary chats.
 * This is the fallback when Redis pub/sub is unavailable.
 */
export const createCancellationPoller = ({
  chatId,
  isTemporary,
  abortController,
  onStop,
  pollIntervalMs = 1000,
}: PollOptions): CancellationSubscriberResult => {
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
    stop: async () => {
      stopped = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      abortController.signal.removeEventListener("abort", onAbort);
    },
    isUsingPubSub: false,
  };
};

/**
 * Creates a hybrid cancellation subscriber that uses Redis pub/sub for instant
 * notifications with fallback to polling when Redis is unavailable.
 *
 * Benefits:
 * - Instant cancellation response when Redis pub/sub is available
 * - Graceful degradation to polling when Redis is unavailable
 */
export const createCancellationSubscriber = async ({
  chatId,
  isTemporary,
  abortController,
  onStop,
  pollIntervalMs = 1000,
}: PollOptions): Promise<CancellationSubscriberResult> => {
  let subscriber: RedisClient | null = null;
  let stopped = false;
  const channel = getCancelChannel(chatId);

  // Cleanup function for Redis subscriber
  const cleanupSubscriber = async () => {
    if (subscriber) {
      try {
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
      } catch {
        // Ignore cleanup errors
      }
      subscriber = null;
    }
  };

  try {
    subscriber = await createRedisSubscriber();

    if (subscriber) {
      // Subscribe to cancellation channel
      await subscriber.subscribe(channel, async (message) => {
        if (stopped) return;

        try {
          const data = JSON.parse(message);
          if (data.canceled) {
            stopped = true;
            abortController.abort();
            onStop();
            await cleanupSubscriber();
          }
        } catch {
          // Invalid message format, ignore
        }
      });

      // Auto-cleanup when abort is triggered externally
      const onAbort = async () => {
        stopped = true;
        onStop();
        await cleanupSubscriber();
      };

      abortController.signal.addEventListener(
        "abort",
        () => {
          onAbort().catch(() => {});
        },
        { once: true },
      );

      return {
        stop: async () => {
          stopped = true;
          await cleanupSubscriber();
        },
        isUsingPubSub: true,
      };
    }
  } catch (error) {
    console.error("[Redis Pub/Sub] Subscription failed:", error);
    await cleanupSubscriber();
  }

  // Fallback to polling when Redis is unavailable
  return createCancellationPoller({
    chatId,
    isTemporary,
    abortController,
    onStop,
    pollIntervalMs,
  });
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
  const maxDuration = mode === "agent" ? 800 : 180;
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
