// A manager belongs to one request/run. Each acquisition already has provider
// retries; subsequent tool calls must not restart that budget indefinitely.
const MAX_FAILED_ACQUISITIONS = 2;
export const CLOUD_ACQUISITION_DEADLINE_MS = 30_000;
// Only a provider-confirmed paused workspace may use this total deadline.
// Discovery, fresh creation and running-workspace reconnects retain 30 seconds.
export const CLOUD_RESUME_DEADLINE_MS = 90_000;

const ACQUISITION_STAGES = [
  "unknown",
  "closing_connection",
  "workspace_lookup",
  "routing",
  "discovery",
  "workspace_identity",
  "connect",
  "create",
  "workspace_verification",
] as const;
export type CloudAcquisitionStage = (typeof ACQUISITION_STAGES)[number];
export const parseCloudAcquisitionStage = (
  value: unknown,
): CloudAcquisitionStage | undefined =>
  ACQUISITION_STAGES.find((stage) => stage === value);

export type ReportCloudAcquisitionStage = (
  stage: CloudAcquisitionStage,
  options?: { resumingPausedWorkspace: boolean },
) => void;

export class CloudAcquisitionTimeoutError extends Error {
  constructor(readonly acquisitionStage: CloudAcquisitionStage = "unknown") {
    super(
      "Cloud connection timed out. Your workspace is preserved. " +
        "Stop retrying cloud tools in this request and ask the user to try again shortly.",
    );
    this.name = "CloudAcquisitionTimeoutError";
  }
}

export class CloudAcquisitionBudgetExhaustedError extends Error {
  constructor(cause: unknown) {
    super(
      "Cloud sandbox acquisition is unavailable for the rest of this request. " +
        "Do not retry cloud tools in this run. Your workspace is preserved; try a new request later.",
      { cause },
    );
    this.name = "CloudAcquisitionBudgetExhaustedError";
  }
}

/** These errors have already spent the request's complete recovery budget. */
export const isCloudAcquisitionBudgetSpent = (error: unknown): boolean =>
  error instanceof CloudAcquisitionTimeoutError ||
  error instanceof CloudAcquisitionBudgetExhaustedError;

export class CloudAcquisitionBudget {
  private failures = 0;
  private failedWaitMs = 0;
  private lastFailure: unknown;

  async run<T>(
    acquire: (
      signal: AbortSignal,
      reportStage: ReportCloudAcquisitionStage,
    ) => Promise<T>,
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
      throw new CloudAcquisitionBudgetExhaustedError(this.lastFailure);
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    let stage: CloudAcquisitionStage = "unknown";
    let stageStartedAt = startedAt;
    let settled = false;
    let deadlineMs = CLOUD_ACQUISITION_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout>;
    let expire: () => void;
    const scheduleDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(
        expire,
        Math.max(0, deadlineMs - this.failedWaitMs - (Date.now() - startedAt)),
      );
    };
    const reportStage: ReportCloudAcquisitionStage = (next, options) => {
      if (
        settled ||
        controller.signal.aborted ||
        !ACQUISITION_STAGES.includes(next)
      )
        return;
      stage = next;
      stageStartedAt = Date.now();
      if (
        next === "connect" &&
        options?.resumingPausedWorkspace &&
        deadlineMs === CLOUD_ACQUISITION_DEADLINE_MS
      ) {
        deadlineMs = CLOUD_RESUME_DEADLINE_MS;
        scheduleDeadline();
      }
    };
    let timeoutError: CloudAcquisitionTimeoutError | undefined;
    const cancel = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", cancel, { once: true });
    let onAbort: () => void;
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      expire = () => {
        timeoutError = new CloudAcquisitionTimeoutError(stage);
        controller.abort(timeoutError);
        reject(timeoutError);
      };
      scheduleDeadline();
    });
    try {
      // The race also bounds adapters that do not support cancellation. Every
      // publisher must check the signal before accepting a late result.
      const result = await Promise.race([
        acquire(controller.signal, reportStage),
        deadline,
      ]);
      controller.signal.throwIfAborted();
      // Only a verified acquisition clears consecutive failures. Resetting a
      // tool's SDK client or health counter must not replenish this budget.
      this.failures = 0;
      this.failedWaitMs = 0;
      this.lastFailure = undefined;
      return result;
    } catch (error) {
      if (context.signal?.aborted && controller.signal.reason !== timeoutError)
        throw error;
      this.failures++;
      this.lastFailure = error;
      this.failedWaitMs += Math.max(0, Date.now() - startedAt);
      if (timeoutError && controller.signal.reason === timeoutError) {
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
            acquisition_stage: stage,
            acquisition_deadline_ms: deadlineMs,
            stage_elapsed_ms: Math.max(0, Date.now() - stageStartedAt),
            reason:
              this.failures >= MAX_FAILED_ACQUISITIONS
                ? "failure_count"
                : "failed_wait",
          }),
        );
        // The failure that spends the last attempt must expose exhaustion too,
        // so callers do not schedule a refresh that this budget will reject.
        if (!isCloudAcquisitionBudgetSpent(error)) {
          throw new CloudAcquisitionBudgetExhaustedError(error);
        }
      }
      throw error;
    } finally {
      settled = true;
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
