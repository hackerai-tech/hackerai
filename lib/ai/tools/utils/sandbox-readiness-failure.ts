import type { SandboxReadinessFailureReason } from "@/types";

/**
 * Classify privacy-safe readiness signals that survive SDK error wrapping.
 * Returns undefined when the error needs SDK-class-specific classification.
 */
export function classifySandboxReadinessFailureSignal(
  error: unknown,
): SandboxReadinessFailureReason | undefined {
  if (!(error instanceof Error)) return undefined;

  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();

  if (message.includes("permission denied")) return "permission_denied";
  if (
    name.includes("sandboxnotfound") ||
    message.includes("not running anymore") ||
    message.includes("sandbox not found") ||
    message.includes("sandbox was not found")
  ) {
    return "sandbox_not_found";
  }
  if (message.includes("sandbox is not running")) return "sandbox_not_running";
  if (message.includes("failed to place sandbox")) return "placement_failure";
  if (
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("connection reset") ||
    message.includes("connection refused") ||
    message.includes("fetch failed") ||
    message.includes("network connection") ||
    message.includes("socket hang up")
  ) {
    return "connection_error";
  }
  if (
    name.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted due to timeout")
  ) {
    return "operation_timeout";
  }

  return undefined;
}
