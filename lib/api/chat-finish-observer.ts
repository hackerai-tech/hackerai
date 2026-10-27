const FINISH_STAGES = [
  "stop_cancellation_subscriber",
  "drain_background_work",
  "settle_usage",
  "wait_title_generation",
  "update_chat",
  "prepare_new_stream",
  "resolve_usage",
  "save_message",
  "flush_telemetry",
  "release_run_lock",
] as const;

type FinishStage = (typeof FINISH_STAGES)[number];
type FinishPhase = "primary" | "provider_retry";

/** One warning budget for all finishing waits, including provider retry callbacks. */
export function createChatFinishObserver(context: {
  requestId?: string;
  userId: string;
  chatId: string;
  mode: string;
}) {
  let warningCount = 0;
  const requestId = context.requestId;
  const identifiers = {
    request_id:
      requestId &&
      requestId.length <= 128 &&
      (/^(?:[a-z0-9-]{1,32}::)?[a-z0-9]{3,12}-\d{13}-[a-f0-9]{12,64}$/.test(
        requestId,
      ) ||
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId))
        ? requestId
        : undefined,
    user_id: /^user_[0-9A-HJKMNP-TV-Z]{26}$/.test(context.userId)
      ? context.userId
      : undefined,
    chat_id: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
      context.chatId,
    )
      ? context.chatId
      : undefined,
  };

  return async function observeFinish<T>(
    stage: FinishStage,
    operation: () => PromiseLike<T>,
    phase: FinishPhase = "primary",
  ): Promise<T> {
    const startedAt = Date.now();
    const timers =
      warningCount >= 2
        ? []
        : [10_000, 60_000].map((thresholdMs) => {
            const timer = setTimeout(() => {
              if (warningCount >= 2) return;
              warningCount++;
              const elapsedMs = Math.max(0, Date.now() - startedAt);
              try {
                console.warn(
                  JSON.stringify({
                    event: "chat_finish_wait_slow",
                    level: "warn",
                    service: "chat-handler",
                    route: "/api/chat",
                    timestamp: new Date().toISOString(),
                    outcome: "pending",
                    stage: FINISH_STAGES.includes(stage) ? stage : "unknown",
                    phase: phase === "provider_retry" ? phase : "primary",
                    mode: ["ask", "agent"].includes(context.mode)
                      ? context.mode
                      : undefined,
                    stage_elapsed_ms: elapsedMs,
                    warning_threshold_ms: thresholdMs,
                    timer_lateness_ms: Math.max(0, elapsedMs - thresholdMs),
                    warning_index: warningCount,
                    ...identifiers,
                  }),
                );
              } catch {
                // Diagnostics must not replace the finishing result or error.
              }
            }, thresholdMs);
            timer.unref?.();
            return timer;
          });
    try {
      return await operation();
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  };
}
