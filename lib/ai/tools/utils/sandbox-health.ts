import type {
  AnySandbox,
  SandboxResourceMetrics,
  SandboxResourceMetricsObserver,
  SandboxResourceObservation,
} from "@/types";
import { createRetryLogger } from "@/lib/posthog/worker";
import { isE2BSandbox } from "./sandbox-types";
import { retryWithBackoff } from "./retry-with-backoff";
import {
  AuthenticationError,
  TemplateError,
  InvalidArgumentError,
} from "./e2b-errors";

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
  });
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
      await observeSandboxResourceFailure(
        sandbox,
        onResourceMetrics,
        "readiness_check_failure",
        "readiness_check_failed",
      ).catch(() => {
        // Analytics must never mask the readiness failure
      });
    }
    throw error;
  }
}
