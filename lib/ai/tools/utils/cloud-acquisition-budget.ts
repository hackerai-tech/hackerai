// A manager belongs to one request/run. Each acquisition already has provider
// retries; subsequent tool calls must not restart that budget indefinitely.
const MAX_FAILED_ACQUISITIONS = 2;
export const CLOUD_ACQUISITION_DEADLINE_MS = 30_000;

export class CloudAcquisitionTimeoutError extends Error {
  constructor() {
    super(
      "Cloud connection timed out. Your workspace is preserved. " +
        "Stop retrying cloud tools in this request and ask the user to try again shortly.",
    );
    this.name = "CloudAcquisitionTimeoutError";
  }
}

export class CloudAcquisitionBudget {
  private failures = 0;
  private failedWaitMs = 0;

  async run<T>(
    acquire: (signal: AbortSignal) => Promise<T>,
    context: {
      userId: string;
      chatId?: string;
      triggerRunId?: string;
      signal?: AbortSignal;
      onTimeout?: () => void;
    },
  ): Promise<T> {
    context.signal?.throwIfAborted();
    if (this.exhausted()) {
      throw new Error(
        "Cloud sandbox acquisition is unavailable for the rest of this request. " +
          "Do not retry cloud tools in this run. Your workspace is preserved; try a new request later.",
      );
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutError = new CloudAcquisitionTimeoutError();
    const cancel = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => {
          controller.abort(timeoutError);
          reject(timeoutError);
        },
        Math.max(0, CLOUD_ACQUISITION_DEADLINE_MS - this.failedWaitMs),
      );
    });
    try {
      // The race also bounds adapters that do not support cancellation. Every
      // publisher must check the signal before accepting a late result.
      const result = await Promise.race([acquire(controller.signal), deadline]);
      controller.signal.throwIfAborted();
      // Only a verified acquisition clears consecutive failures. Resetting a
      // tool's SDK client or health counter must not replenish this budget.
      this.failures = 0;
      this.failedWaitMs = 0;
      return result;
    } catch (error) {
      this.failures++;
      this.failedWaitMs += Math.max(0, Date.now() - startedAt);
      if (controller.signal.reason === timeoutError) {
        this.failedWaitMs = Math.max(
          this.failedWaitMs,
          CLOUD_ACQUISITION_DEADLINE_MS,
        );
        try {
          context.onTimeout?.();
        } catch {
          /* A closed stream cannot extend the deadline. */
        }
      }
      if (this.exhausted()) {
        console.warn(
          JSON.stringify({
            event: "cloud_sandbox_acquisition_budget_exhausted",
            user_id: context.userId,
            chat_id: context.chatId,
            trigger_run_id: context.triggerRunId,
            failed_acquisitions: this.failures,
            failed_acquisition_wait_ms: this.failedWaitMs,
            reason:
              this.failures >= MAX_FAILED_ACQUISITIONS
                ? "failure_count"
                : "failed_wait",
          }),
        );
      }
      throw error;
    } finally {
      clearTimeout(timer!);
      context.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort!);
    }
  }

  private exhausted() {
    return (
      this.failures >= MAX_FAILED_ACQUISITIONS ||
      this.failedWaitMs >= CLOUD_ACQUISITION_DEADLINE_MS
    );
  }
}
