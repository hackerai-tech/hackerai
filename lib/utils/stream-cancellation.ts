import {
  getCancellationStatus,
  getTempCancellationStatus,
} from "@/lib/db/actions";
import {
  createRedisSubscriber,
  getCancelChannel,
} from "@/lib/utils/redis-pubsub";
import { createClient } from "redis";
import { nextJsAxiomLogger } from "@/lib/axiom/server";

// Use the same type as redis-pubsub.ts
type RedisClient = ReturnType<typeof createClient>;

type PollOptions = {
  chatId: string;
  isTemporary: boolean;
  abortController: AbortController;
  onStop: () => void;
  pollIntervalMs?: number;
};

type ApiEndpoint = "/api/chat" | "/api/agent" | "/api/chat/[id]/stream";

type PreemptiveTimeoutOptions = {
  chatId: string;
  endpoint: ApiEndpoint;
  abortController: AbortController;
  safetyBuffer?: number;
};

type CancellationSubscriberResult = {
  stop: () => Promise<void>;
  isUsingPubSub: boolean;
  shouldSkipSave: () => boolean;
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
    shouldSkipSave: () => false,
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
  let onStopCalled = false;
  const channel = getCancelChannel(chatId);

  // Ensure onStop is only called once
  const callOnStopOnce = () => {
    if (!onStopCalled) {
      onStopCalled = true;
      onStop();
    }
  };

  // Cleanup function for Redis subscriber (fire-and-forget safe)
  const cleanupSubscriber = () => {
    if (subscriber) {
      const sub = subscriber;
      subscriber = null;
      sub.unsubscribe(channel).catch(() => {});
      sub.quit().catch(() => {});
    }
  };

  try {
    subscriber = await createRedisSubscriber();

    if (subscriber) {
      // Track skipSave flag from cancellation message
      let skipSave = false;

      // Named handler so we can remove it on manual stop
      const handleAbort = () => {
        stopped = true;
        callOnStopOnce();
        cleanupSubscriber();
      };

      // Subscribe to cancellation channel (synchronous callback)
      // Just trigger abort - the abort handler is the single source of truth for cleanup
      await subscriber.subscribe(channel, (message) => {
        if (stopped) return;

        try {
          const data = JSON.parse(message);
          if (data.canceled) {
            stopped = true;
            if (data.skipSave) skipSave = true;
            abortController.abort();
            // handleAbort will be called by the abort event listener
          }
        } catch {
          // Invalid message format, ignore
        }
      });

      abortController.signal.addEventListener("abort", handleAbort, {
        once: true,
      });

      return {
        stop: async () => {
          stopped = true;
          abortController.signal.removeEventListener("abort", handleAbort);
          cleanupSubscriber();
        },
        isUsingPubSub: true,
        shouldSkipSave: () => skipSave,
      };
    }
  } catch (error) {
    console.error("[Redis Pub/Sub] Subscription failed:", error);
    cleanupSubscriber();
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
  endpoint,
  abortController,
  safetyBuffer = 30,
}: PreemptiveTimeoutOptions) => {
  // Use endpoint-specific max duration based on Vercel function limits
  const maxDuration = endpoint === "/api/chat" ? 180 : 800;
  const maxStreamTime = (maxDuration - safetyBuffer) * 1000;
  const startTime = Date.now();

  let isPreemptive = false;
  let triggerTime: number | null = null;

  const timeoutId = setTimeout(() => {
    triggerTime = Date.now();
    isPreemptive = true;

    nextJsAxiomLogger.info("Preemptive timeout triggered", {
      chatId,
      endpoint,
      maxDuration,
      safetyBuffer,
      maxStreamTimeMs: maxStreamTime,
      elapsedMs: triggerTime - startTime,
      triggerTime: new Date(triggerTime).toISOString(),
    });

    abortController.abort();
  }, maxStreamTime);

  return {
    timeoutId,
    clear: () => clearTimeout(timeoutId),
    isPreemptive: () => isPreemptive,
    getTriggerTime: () => triggerTime,
    getStartTime: () => startTime,
  };
};
