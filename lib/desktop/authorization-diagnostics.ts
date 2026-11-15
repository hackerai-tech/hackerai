/**
 * Correlates a redeemed native Desktop authorization with its dispatched
 * command. This measures only the server decision after a valid request body
 * and Redis lookup; it cannot observe response delivery, native execution, or
 * requests that never reach a decision. Nothing here may affect approval.
 */

const DIAGNOSTIC_VERSION = 1;
const SLOW_DECISION_MS = 5000;
const MAX_REPORTED_MS = 600_000;
const COMMAND_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AuthorizationDiagnostic = {
  version: typeof DIAGNOSTIC_VERSION;
  commandId: string;
  issuedAtMs: number;
};

export type DesktopAuthorizationDecision = "approved" | "mismatch";

/** Reads a plain data property without invoking getters or inherited values. */
function ownDataValue(object: unknown, key: string): unknown {
  if (object === null || typeof object !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isCommandId(value: unknown): value is string {
  return typeof value === "string" && COMMAND_ID_PATTERN.test(value);
}

/** Only commands carrying a server-generated UUID gain correlation metadata. */
export function createAuthorizationDiagnostic(
  payload: Record<string, unknown>,
): AuthorizationDiagnostic | undefined {
  try {
    const commandId = ownDataValue(payload, "commandId");
    if (!isCommandId(commandId)) return undefined;
    return { version: DIAGNOSTIC_VERSION, commandId, issuedAtMs: Date.now() };
  } catch {
    return undefined;
  }
}

/** Legacy, unknown-version, or malformed metadata is ignored, never rejected. */
export function readAuthorizationDiagnostic(
  record: unknown,
): AuthorizationDiagnostic | undefined {
  try {
    const value = ownDataValue(record, "diagnostic");
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    if (Reflect.ownKeys(value).length !== 3) return undefined;
    const version = ownDataValue(value, "version");
    const commandId = ownDataValue(value, "commandId");
    const issuedAtMs = ownDataValue(value, "issuedAtMs");
    if (
      version !== DIAGNOSTIC_VERSION ||
      !isCommandId(commandId) ||
      typeof issuedAtMs !== "number" ||
      !Number.isSafeInteger(issuedAtMs) ||
      issuedAtMs <= 0
    ) {
      return undefined;
    }
    return { version: DIAGNOSTIC_VERSION, commandId, issuedAtMs };
  } catch {
    return undefined;
  }
}

function boundedMs(value: number): { ms: number; clamped: boolean } {
  if (!Number.isFinite(value) || value < 0) return { ms: 0, clamped: true };
  if (value > MAX_REPORTED_MS) return { ms: MAX_REPORTED_MS, clamped: true };
  return { ms: Math.round(value), clamped: false };
}

/**
 * Emits at most one fixed-field event: every digest mismatch, slow issuance or
 * handling, and a stable 1/16 sample of command UUIDs. `performance.now()`
 * values bound the handler and lookup; operation age compares wall clocks
 * across the issuing and redeeming servers. Negative or out-of-range values
 * are clamped; otherwise bounded values do not establish clock synchronization.
 */
export function recordDesktopAuthorizationDecision(
  diagnostic: AuthorizationDiagnostic | undefined,
  decision: DesktopAuthorizationDecision,
  timing: { handlerStartedAt: number; lookupStartedAt: number },
): void {
  try {
    if (!diagnostic || !isCommandId(diagnostic.commandId)) return;
    const decidedAt = performance.now();
    const operationAge = boundedMs(Date.now() - diagnostic.issuedAtMs);
    const handlerElapsed = boundedMs(decidedAt - timing.handlerStartedAt);
    const lookupElapsed = boundedMs(decidedAt - timing.lookupStartedAt);
    const sampleReason =
      decision === "mismatch"
        ? "mismatch"
        : operationAge.ms >= SLOW_DECISION_MS ||
            handlerElapsed.ms >= SLOW_DECISION_MS
          ? "slow"
          : diagnostic.commandId.startsWith("0")
            ? "sampled"
            : undefined;
    if (!sampleReason) return;
    console.info(
      JSON.stringify({
        event: "desktop_authorization_decision",
        desktop_authorization_decision_diagnostic_version: DIAGNOSTIC_VERSION,
        command_id: diagnostic.commandId,
        decision: decision === "mismatch" ? "mismatch" : "approved",
        sample_reason: sampleReason,
        operation_age_ms: operationAge.ms,
        handler_elapsed_ms: handlerElapsed.ms,
        lookup_elapsed_ms: lookupElapsed.ms,
        timing_status:
          operationAge.clamped ||
          handlerElapsed.clamped ||
          lookupElapsed.clamped
            ? "clamped"
            : "within_bounds",
      }),
    );
  } catch {
    // Diagnostics must never change an authorization decision or response.
  }
}
