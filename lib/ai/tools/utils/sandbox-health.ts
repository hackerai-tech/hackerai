import type {
  AnySandbox,
  SandboxLifecycleState,
  SandboxReadinessFailureReason,
  SandboxReadinessStage,
  SandboxRecoveryOutcome,
  SandboxResourceMetrics,
  SandboxResourceMetricsObserver,
  SandboxResourceObservation,
  TerminalTimeoutOutcome,
  TerminalTimeoutRecoveryOutcome,
} from "@/types";
import { createRetryLogger } from "@/lib/posthog/worker";
import { isE2BSandbox } from "./sandbox-types";
import { retryWithBackoff } from "./retry-with-backoff";
import {
  AuthenticationError,
  CommandExitError,
  TemplateError,
  InvalidArgumentError,
  NotEnoughSpaceError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
} from "./e2b-errors";
import { classifySandboxReadinessFailureSignal } from "./sandbox-readiness-failure";

const sandboxHealthLogger = createRetryLogger("sandbox-health");

const CPU_WARNING_THRESHOLD = 95; // percentage
const MEM_WARNING_THRESHOLD = 90; // percentage
const FAILURE_METRICS_TIMEOUT_MS = 1000;

/**
 * Check sandbox resource metrics and return a diagnostic summary.
 * Returns null if metrics are unavailable (non-E2B sandbox or API error).
 */
async function checkSandboxMetrics(
  sandbox: AnySandbox,
): Promise<(SandboxResourceMetrics & { warning: string | null }) | null> {
  if (!isE2BSandbox(sandbox)) return null;

  try {
    const metrics = await sandbox.getMetrics();
    if (!metrics.length) return null;

    const latest = metrics[metrics.length - 1];
    const cpuPct = latest.cpuUsedPct;
    const memPct =
      latest.memTotal > 0 ? (latest.memUsed / latest.memTotal) * 100 : 0;
    const diskPct =
      latest.diskTotal > 0 ? (latest.diskUsed / latest.diskTotal) * 100 : 0;

    const warnings: string[] = [];
    if (cpuPct > CPU_WARNING_THRESHOLD) {
      warnings.push(`CPU at ${cpuPct.toFixed(0)}%`);
    }
    if (memPct > MEM_WARNING_THRESHOLD) {
      warnings.push(
        `Memory at ${memPct.toFixed(0)}% (${Math.round(latest.memUsed / 1024 / 1024)}/${Math.round(latest.memTotal / 1024 / 1024)} MB)`,
      );
    }

    return {
      cpuPct,
      memPct,
      diskPct,
      warning: warnings.length > 0 ? warnings.join(", ") : null,
    };
  } catch {
    // Metrics API failure shouldn't block health checks
    return null;
  }
}

function notifyResourceObserver(
  observer: SandboxResourceMetricsObserver | undefined,
  observation: SandboxResourceObservation,
): void {
  if (!observer) return;

  try {
    observer(observation);
  } catch {
    // Analytics must never block sandbox health checks or command handling
  }
}

function stripWarning(
  metrics: (SandboxResourceMetrics & { warning: string | null }) | null,
): SandboxResourceMetrics | null {
  if (!metrics) return null;
  return {
    cpuPct: metrics.cpuPct,
    memPct: metrics.memPct,
    diskPct: metrics.diskPct,
  };
}

export async function observeSandboxResourceFailure(
  sandbox: AnySandbox,
  observer: SandboxResourceMetricsObserver | undefined,
  source: "readiness_check_failure" | "terminal_command_timeout",
  failureType: "readiness_check_failed" | "terminal_command_timed_out",
  details: {
    failureReason?: SandboxReadinessFailureReason;
    readinessStage?: SandboxReadinessStage;
    lifecycleState?: SandboxLifecycleState;
    timeoutSeconds?: number;
    terminalTimeoutOutcome?: TerminalTimeoutOutcome;
    terminationAttempted?: boolean;
    terminationSucceeded?: boolean;
    sessionReturned?: boolean;
    isBackground?: boolean;
  } = {},
): Promise<void> {
  if (!observer || !isE2BSandbox(sandbox)) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const metrics = await Promise.race([
    checkSandboxMetrics(sandbox),
    new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), FAILURE_METRICS_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  notifyResourceObserver(observer, {
    kind: "failure",
    source,
    failureType,
    metrics: stripWarning(metrics),
    ...details,
  });
}

export function observeSandboxRecovery(
  observer: SandboxResourceMetricsObserver | undefined,
  details: {
    outcome: SandboxRecoveryOutcome;
    initialFailureReason: SandboxReadinessFailureReason;
    finalFailureReason?: SandboxReadinessFailureReason;
  },
): void {
  notifyResourceObserver(observer, {
    kind: "recovery",
    source: "readiness_reconnect",
    ...details,
  });
}

export function observeTerminalTimeoutRecovery(
  observer: SandboxResourceMetricsObserver | undefined,
  outcome: TerminalTimeoutRecoveryOutcome,
): void {
  notifyResourceObserver(observer, {
    kind: "timeout_recovery",
    source: "terminal_command_timeout",
    outcome,
  });
}

/**
 * Reduce E2B/OS errors to privacy-safe, low-cardinality readiness categories.
 * Never include raw messages because command/runtime errors may contain user data.
 */
export function classifySandboxReadinessFailureReason(
  error: unknown,
): SandboxReadinessFailureReason {
  if (!(error instanceof Error)) return "unknown";

  // Check wrapped message/name signals before SDK classes. E2B can wrap a
  // failed fork/exec in InvalidArgumentError even when caller input is valid.
  const signal = classifySandboxReadinessFailureSignal(error);
  if (signal) return signal;

  if (error instanceof AuthenticationError) return "authentication";
  if (error instanceof TemplateError) return "template";
  if (error instanceof RateLimitError) return "rate_limit";
  if (error instanceof NotEnoughSpaceError) return "disk_space";
  if (error instanceof NotFoundError) return "sandbox_not_found";
  if (error instanceof TimeoutError) return "operation_timeout";
  if (error instanceof CommandExitError) return "command_exit";
  if (error instanceof InvalidArgumentError) return "invalid_argument";

  return "unknown";
}

export function inferSandboxLifecycleState(
  failureReason: SandboxReadinessFailureReason,
): SandboxLifecycleState {
  if (failureReason === "sandbox_not_running") return "not_running";
  if (failureReason === "sandbox_not_found") return "missing";
  if (
    failureReason === "permission_denied" ||
    failureReason === "invalid_argument" ||
    failureReason === "command_exit"
  ) {
    return "running_not_ready";
  }
  return "unknown";
}

/**
 * Build a diagnostic message from metrics for error context.
 */
export async function getSandboxDiagnostics(
  sandbox: AnySandbox,
): Promise<string> {
  const metrics = await checkSandboxMetrics(sandbox);
  if (!metrics) return "metrics unavailable";
  return `CPU: ${metrics.cpuPct.toFixed(0)}%, Memory: ${metrics.memPct.toFixed(0)}%, Disk: ${metrics.diskPct.toFixed(0)}%`;
}

/**
 * Wait for sandbox to become available and ready to execute commands.
 *
 * Performs status check, resource metrics check, AND actual command execution
 * test to ensure sandbox is truly ready, not just "running" but unresponsive.
 *
 * @param sandbox - Sandbox instance to check
 * @param maxRetries - Maximum number of health check attempts (default: 5)
 * @param signal - Optional abort signal to cancel health checks
 * @returns Promise that resolves when sandbox is ready
 * @throws Error if sandbox doesn't become ready after all retries
 */
export async function waitForSandboxReady(
  sandbox: AnySandbox,
  maxRetries: number = 5,
  signal?: AbortSignal,
  onResourceMetrics?: SandboxResourceMetricsObserver,
  readinessStage: SandboxReadinessStage = "initial",
): Promise<void> {
  try {
    await retryWithBackoff(
      async () => {
        // For E2B Sandbox, check if it's running first
        if (isE2BSandbox(sandbox)) {
          const running = await sandbox.isRunning();
          if (!running) {
            throw new Error("Sandbox is not running");
          }

          // Check resource metrics for early warning
          const metrics = await checkSandboxMetrics(sandbox);
          if (metrics) {
            notifyResourceObserver(onResourceMetrics, {
              kind: "health_sample",
              source: "pre_command_health_check",
              metrics: stripWarning(metrics)!,
            });
          }
          if (metrics?.warning) {
            console.warn(
              `[Sandbox Health] Resource pressure detected: ${metrics.warning}`,
            );
          }
        }

        // Verify it can actually execute commands with a simple test
        try {
          await sandbox.commands.run("echo ready", {
            timeoutMs: 5000, // 5 second timeout for health check (envd can be slow under CPU pressure)
            // Hide from local CLI output (empty string = hide)
            displayName: "",
          } as { timeoutMs: number; displayName?: string });
        } catch (error) {
          // Enrich error with metrics context for debugging
          let metricsContext = "";
          try {
            metricsContext = ` [${await getSandboxDiagnostics(sandbox)}]`;
          } catch {
            // Don't let metrics failure mask the real error
          }

          // Re-throw original error to preserve instanceof checks for
          // isPermanentError (AuthenticationError, TemplateError, etc.)
          if (error instanceof Error) {
            error.message = `Sandbox running but not ready to execute commands${metricsContext}: ${error.message}`;
            throw error;
          }
          throw new Error(
            `Sandbox running but not ready to execute commands${metricsContext}: ${error}`,
          );
        }
      },
      {
        maxRetries,
        baseDelayMs: 1000, // 1s, 2s, 4s, 8s, 16s (~31s total for 5 retries)
        jitterMs: 100,
        isPermanentError: (error: unknown) => {
          // Auth and template errors will never recover by retrying health checks
          if (error instanceof AuthenticationError) return true;
          if (error instanceof TemplateError) return true;
          if (error instanceof InvalidArgumentError) return true;
          return false; // All other errors: keep retrying - sandbox might be starting
        },
        logger: (message, error) => {
          // Only log final failure (when it gives up)
          if (message.includes("failed after")) {
            sandboxHealthLogger(message, error);
          }
        },
        signal,
      },
    );
  } catch (error) {
    const wasAborted =
      signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    if (!wasAborted) {
      const failureReason = classifySandboxReadinessFailureReason(error);
      await observeSandboxResourceFailure(
        sandbox,
        onResourceMetrics,
        "readiness_check_failure",
        "readiness_check_failed",
        {
          failureReason,
          readinessStage,
          lifecycleState: inferSandboxLifecycleState(failureReason),
        },
      ).catch(() => {
        // Analytics must never mask the readiness failure
      });
    }
    throw error;
  }
}
