import { ChatSDKError } from "@/lib/errors";
import { phLogger } from "@/lib/posthog/server";
import {
  describeCloudUnavailability,
  type CloudDisabledReason,
  type CloudUnavailability,
} from "./cloud-unavailability-message";

// A manager belongs to one request/run. Each acquisition already has provider
// retries; subsequent tool calls must not restart that budget indefinitely.
const MAX_FAILED_ACQUISITIONS = 2;
// A spent budget pauses cloud tools for a cooldown instead of the whole run.
// Cooldowns grow 60s, 120s, 240s, then stay at 5 minutes (each +/-20% jitter).
// Re-probes are lazy: the next cloud tool call after the cooldown makes one
// acquisition attempt within the ordinary per-call deadline. No timer runs
// while cooling down, so cancellation has nothing to clean up.
export const CLOUD_COOLDOWN_BASE_MS = 60_000;
export const CLOUD_COOLDOWN_MAX_MS = 300_000;
// Bounds automatic recovery per run; the next spent budget disables cloud tools.
export const MAX_CLOUD_REPROBES = 5;
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
        "A later sandbox tool call will try to reconnect automatically; continue with work that does not need the sandbox.",
    );
    this.name = "CloudAcquisitionTimeoutError";
  }
}

export class CloudAcquisitionBudgetExhaustedError extends Error {
  readonly retryAfterMs?: number;
  readonly disabledReason?: CloudDisabledReason;

  constructor(
    cause: unknown,
    state: CloudUnavailability = {
      kind: "cooldown",
      retryAfterMs: CLOUD_COOLDOWN_BASE_MS,
    },
  ) {
    super(describeCloudUnavailability(state), { cause });
    this.name = "CloudAcquisitionBudgetExhaustedError";
    if (state.kind === "cooldown") this.retryAfterMs = state.retryAfterMs;
    else this.disabledReason = state.reason;
  }
}

/** These errors have already spent the request's current recovery budget. */
export const isCloudAcquisitionBudgetSpent = (error: unknown): boolean =>
  error instanceof CloudAcquisitionTimeoutError ||
  error instanceof CloudAcquisitionBudgetExhaustedError;

/**
 * Failures that another attempt in this run cannot fix. Everything else,
 * including timeouts, provider 5xx/busy, connect/resume and workspace-guard
 * store errors, is transient: retrying is safe because every acquisition
 * re-runs the workspace guards. A missing pinned workspace is never replaced
 * automatically; it needs the customer-confirmed recovery flow.
 */
export function classifyPermanentCloudFailure(
  error: unknown,
): Exclude<CloudDisabledReason, "reprobe_limit"> | undefined {
  if (error instanceof ChatSDKError)
    return error.type === "forbidden" || error.type === "unauthorized"
      ? "account_restricted"
      : undefined;
  if (!(error instanceof Error)) return undefined;
  if (error.name === "E2BRegionUnavailableError") return "configuration";
  if (error.name !== "E2BAcquisitionError") return undefined;
  const { diagnostics, errorKind } = error as {
    diagnostics?: Record<string, unknown>;
    errorKind?: unknown;
  };
  const status = diagnostics?.e2b_http_status;
  if (errorKind === "authentication" || status === 401 || status === 403)
    return "authorization";
  const identity = diagnostics?.e2b_workspace_identity_operation;
  if (
    identity === "validate" ||
    (identity === "get_info" && (errorKind === "not_found" || status === 404))
  )
    return "workspace_recovery_required";
  if (
    errorKind === "template" ||
    errorKind === "invalid_argument" ||
    errorKind === "egress_configuration"
  )
    return "configuration";
  return undefined;
}

const isTypedProviderTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  error.name === "E2BAcquisitionError" &&
  (error as { errorKind?: unknown }).errorKind === "timeout";

export type CloudAvailabilityTelemetry = {
  userId: string;
  chatId?: string;
  triggerRunId?: string;
  subscription?: string;
  runKind?: "parent" | "subagent";
  triggerRegion?: string;
};

type FailureSource = "acquisition" | "readiness";
type Availability =
  | { kind: "available" }
  | { kind: "cooldown"; retryAt: number; source: FailureSource }
  | { kind: "disabled"; reason: CloudDisabledReason };
type Reprobe = { index: number; source: FailureSource; startedAt: number };

const errorName = (error: unknown): string | undefined =>
  error === undefined
    ? undefined
    : error instanceof Error
      ? error.name
      : "NonError";

export class CloudAcquisitionBudget {
  private failures = 0;
  private failedWaitMs = 0;
  private lastFailure: unknown;
  private availability: Availability = { kind: "available" };
  private cooldowns = 0;
  private reprobes = 0;

  constructor(private readonly random: () => number = Math.random) {}

  /** Whether cloud tools must wait or stop now. An expired cooldown is not blocked. */
  isBlocked(): boolean {
    return this.unavailability() !== undefined;
  }

  /** A cached client must not bypass a cooldown or the re-probe that ends it. */
  blocksCachedSandbox(): boolean {
    return this.availability.kind !== "available";
  }

  /** Model-facing reason while blocked, including when cloud tools will retry. */
  blockedMessage(): string | undefined {
    const state = this.unavailability();
    return state && describeCloudUnavailability(state);
  }

  /** The sandbox answered a readiness check; end a readiness cooldown early. */
  recordReadinessSuccess(): void {
    if (this.availability.kind === "cooldown")
      this.availability = { kind: "available" };
  }

  /** Readiness failed after its reconnect; pause cloud tools like a spent acquisition. */
  recordReadinessFailure(telemetry: CloudAvailabilityTelemetry): void {
    // Concurrent checks of one outage must not escalate the backoff twice.
    if (this.isBlocked()) return;
    this.enterCooldown(telemetry, { source: "readiness" });
  }

  async run<T>(
    acquire: (
      signal: AbortSignal,
      reportStage: ReportCloudAcquisitionStage,
    ) => Promise<T>,
    context: CloudAvailabilityTelemetry & {
      signal?: AbortSignal;
      onTimeout?: () => void;
    },
  ): Promise<T> {
    context.signal?.throwIfAborted();
    const reprobe = this.admit(context);
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
      if (reprobe) this.reportReprobe(context, reprobe, "success");
      return result;
    } catch (error) {
      if (
        context.signal?.aborted &&
        controller.signal.reason !== timeoutError
      ) {
        // A canceled re-probe proves nothing; the next call may probe again.
        if (reprobe) {
          this.availability = {
            kind: "cooldown",
            retryAt: Date.now(),
            source: reprobe.source,
          };
          this.reportReprobe(context, reprobe, "canceled");
        }
        throw error;
      }
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
      // A provider request timeout (e.g. pinned getInfo) spends the episode
      // just like this budget's own deadline: cool down after one timeout.
      if (isTypedProviderTimeout(error)) {
        this.failedWaitMs = Math.max(
          this.failedWaitMs,
          CLOUD_ACQUISITION_DEADLINE_MS,
        );
      }
      const permanent = classifyPermanentCloudFailure(error);
      // A re-probe gets one attempt; its failure starts the next cooldown.
      if (permanent || reprobe || this.exhausted()) {
        const failure = {
          failed_acquisitions: this.failures,
          failed_acquisition_wait_ms: this.failedWaitMs,
          acquisition_stage: stage,
          acquisition_deadline_ms: deadlineMs,
          stage_elapsed_ms: Math.max(0, Date.now() - stageStartedAt),
          reason: permanent
            ? "permanent_failure"
            : reprobe
              ? "reprobe_failed"
              : this.failures >= MAX_FAILED_ACQUISITIONS
                ? "failure_count"
                : "failed_wait",
        };
        if (reprobe) this.reportReprobe(context, reprobe, "failure", error);
        const state = permanent
          ? this.disable(context, permanent, error)
          : this.enterCooldown(context, { source: "acquisition", error });
        console.warn(
          JSON.stringify({
            event: "cloud_sandbox_acquisition_budget_exhausted",
            user_id: context.userId,
            chat_id: context.chatId,
            trigger_run_id: context.triggerRunId,
            ...failure,
            availability_state: state.kind,
            ...(state.kind === "cooldown"
              ? { cooldown_ms: state.retryAfterMs }
              : { disabled_reason: state.reason }),
          }),
        );
        // Preserve the original error for a permanent failure (for example a
        // suspension) so callers keep their existing handling; later calls
        // receive the disabled reason. The timeout keeps its identity and stage.
        if (permanent) throw error;
        if (timeoutError && error === timeoutError) {
          timeoutError.message =
            "Cloud connection timed out. " + describeCloudUnavailability(state);
          throw error;
        }
        // The failure that spends the last attempt must expose exhaustion too,
        // so callers do not schedule a refresh that this budget will reject.
        if (!isCloudAcquisitionBudgetSpent(error)) {
          throw new CloudAcquisitionBudgetExhaustedError(error, state);
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

  private unavailability(): CloudUnavailability | undefined {
    const state = this.availability;
    if (state.kind === "disabled") return state;
    if (state.kind === "cooldown") {
      const retryAfterMs = state.retryAt - Date.now();
      if (retryAfterMs > 0) return { kind: "cooldown", retryAfterMs };
    }
    return undefined;
  }

  /** Refuse while blocked; an expired cooldown admits one re-probe. */
  private admit(telemetry: CloudAvailabilityTelemetry): Reprobe | undefined {
    const blocked = this.unavailability();
    if (blocked)
      throw new CloudAcquisitionBudgetExhaustedError(this.lastFailure, blocked);
    const state = this.availability;
    if (state.kind !== "cooldown") return undefined;
    if (this.reprobes >= MAX_CLOUD_REPROBES) {
      const disabled = this.disable(telemetry, "reprobe_limit");
      throw new CloudAcquisitionBudgetExhaustedError(
        this.lastFailure,
        disabled,
      );
    }
    this.reprobes++;
    this.availability = { kind: "available" };
    return {
      index: this.reprobes,
      source: state.source,
      startedAt: Date.now(),
    };
  }

  private enterCooldown(
    telemetry: CloudAvailabilityTelemetry,
    failure: { source: FailureSource; error?: unknown },
  ): CloudUnavailability {
    this.failures = 0;
    this.failedWaitMs = 0;
    if (this.reprobes >= MAX_CLOUD_REPROBES)
      return this.disable(telemetry, "reprobe_limit", failure.error);
    const backoffMs = Math.min(
      CLOUD_COOLDOWN_MAX_MS,
      CLOUD_COOLDOWN_BASE_MS * 2 ** this.cooldowns,
    );
    const cooldownMs = Math.min(
      CLOUD_COOLDOWN_MAX_MS,
      Math.round(backoffMs * (0.8 + 0.4 * this.random())),
    );
    this.cooldowns++;
    this.availability = {
      kind: "cooldown",
      retryAt: Date.now() + cooldownMs,
      source: failure.source,
    };
    this.report("cloud_sandbox_cooldown_entered", telemetry, {
      failure_source: failure.source,
      error_name: errorName(failure.error),
      cooldown_ms: cooldownMs,
      cooldown_index: this.cooldowns,
    });
    return { kind: "cooldown", retryAfterMs: cooldownMs };
  }

  private disable(
    telemetry: CloudAvailabilityTelemetry,
    reason: CloudDisabledReason,
    error?: unknown,
  ): CloudUnavailability {
    this.availability = { kind: "disabled", reason };
    this.report("cloud_sandbox_disabled_for_run", telemetry, {
      disabled_reason: reason,
      error_name: errorName(error),
    });
    return { kind: "disabled", reason };
  }

  private reportReprobe(
    telemetry: CloudAvailabilityTelemetry,
    reprobe: Reprobe,
    outcome: "success" | "failure" | "canceled",
    error?: unknown,
  ): void {
    this.report("cloud_sandbox_reprobe_completed", telemetry, {
      outcome,
      failure_source: reprobe.source,
      reprobe_index: reprobe.index,
      duration_ms: Math.max(0, Date.now() - reprobe.startedAt),
      error_name: errorName(error),
    });
  }

  /** Content-free availability analytics; never commands, paths or targets. */
  private report(
    event: string,
    telemetry: CloudAvailabilityTelemetry,
    fields: Record<string, string | number | undefined>,
  ): void {
    try {
      phLogger.event(event, {
        userId: telemetry.userId,
        chat_id: telemetry.chatId,
        trigger_run_id: telemetry.triggerRunId,
        subscription_tier: telemetry.subscription,
        agent_run_kind: telemetry.runKind ?? "parent",
        trigger_region: telemetry.triggerRegion,
        sandbox_type: "cloud",
        reprobes_used: this.reprobes,
        max_reprobes: MAX_CLOUD_REPROBES,
        cooldowns_entered: this.cooldowns,
        cloud_sandbox_availability_event_version: 1,
        ...fields,
      });
    } catch {
      /* Analytics must never change cloud availability decisions. */
    }
  }
}
