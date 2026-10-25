import type { SandboxReadinessFailureReason } from "@/types";

/**
 * Classify privacy-safe readiness signals that survive SDK error wrapping.
 * Returns undefined when the error needs SDK-class-specific classification.
 */
export function classifySandboxReadinessFailureSignal(
  error: unknown,
): SandboxReadinessFailureReason | undefined {
  if (!(error instanceof Error)) return undefined;

  // A spent request budget blocks new work; it must not erase the reason the
  // acquisition failed. Unwrap only our own wrapper, never arbitrary chains.
  if (
    error.name === "CloudAcquisitionBudgetExhaustedError" &&
    error.cause instanceof Error &&
    error.cause.name !== "CloudAcquisitionBudgetExhaustedError"
  ) {
    return classifySandboxReadinessFailureSignal(error.cause);
  }

  // The acquisition boundary deliberately replaces provider prose with safe
  // copy. Classify its finite diagnostics, not that replacement message.
  if (error.name === "E2BAcquisitionError" && "diagnostics" in error) {
    const diagnostics = error.diagnostics;
    if (diagnostics && typeof diagnostics === "object") {
      const fields = diagnostics as Record<string, unknown>;
      if (
        fields.e2b_http_status === 504 ||
        fields.e2b_error_code === "TIMEOUT" ||
        fields.e2b_error_code === "GATEWAY_TIMEOUT"
      )
        return "operation_timeout";
      if (
        fields.e2b_error_category === "transient" ||
        fields.e2b_error_category === "rate_limit"
      )
        return "connection_error";
    }
  }

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
