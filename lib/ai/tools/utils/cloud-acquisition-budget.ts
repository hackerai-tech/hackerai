// A manager belongs to one request/run. Each acquisition already has provider
// retries; subsequent tool calls must not restart that budget indefinitely.
const MAX_FAILED_ACQUISITIONS = 2;
const MAX_FAILED_ACQUISITION_WAIT_MS = 120_000;

export class CloudAcquisitionBudget {
  private failures = 0;
  private failedWaitMs = 0;

  async run<T>(
    acquire: () => Promise<T>,
    context: { userId: string; chatId?: string; triggerRunId?: string },
  ): Promise<T> {
    if (this.exhausted()) {
      throw new Error(
        "Cloud sandbox acquisition is unavailable for the rest of this request. " +
          "Do not retry cloud tools in this run. Your workspace is preserved; try a new request later.",
      );
    }
    const startedAt = Date.now();
    try {
      const result = await acquire();
      // Only a verified acquisition clears consecutive failures. Resetting a
      // tool's SDK client or health counter must not replenish this budget.
      this.failures = 0;
      this.failedWaitMs = 0;
      return result;
    } catch (error) {
      this.failures++;
      this.failedWaitMs += Math.max(0, Date.now() - startedAt);
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
    }
  }

  private exhausted() {
    return (
      this.failures >= MAX_FAILED_ACQUISITIONS ||
      this.failedWaitMs >= MAX_FAILED_ACQUISITION_WAIT_MS
    );
  }
}
