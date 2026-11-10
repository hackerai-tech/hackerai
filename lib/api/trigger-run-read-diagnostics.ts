import type { runs } from "@trigger.dev/sdk";

// SDK4.7.7 forwards this core callback before its default payload/output
// preparation. Its public runs.retrieve options type omits the core callback;
// the installed-SDK contract test protects that version-sensitive boundary.
type ObservedReadOptions = NonNullable<Parameters<typeof runs.retrieve>[1]> & {
  onResponseBody: () => void;
};

const MAX_ELAPSED_MS = 60_000;

const readClock = (): number | null => {
  try {
    const value = Date.now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
};

/** Observe API-body validation without reading the body, span or response.
 * Absence cannot distinguish network/retry/schema work or a missing callback.
 */
export function createTriggerRunReadDiagnostics() {
  const startedAt = readClock();
  let observed = false;
  let elapsedMs: number | null = null;
  let capped = false;
  const requestOptions: ObservedReadOptions = {
    onResponseBody: () => {
      if (observed) return;
      observed = true;
      const now = readClock();
      if (startedAt !== null && now !== null) {
        const elapsed = Math.max(0, now - startedAt);
        elapsedMs = Math.min(MAX_ELAPSED_MS, elapsed);
        capped = elapsed > MAX_ELAPSED_MS;
      }
    },
  };
  return {
    requestOptions,
    snapshot: () => ({
      trigger_run_read_diagnostic_version: 1 as const,
      trigger_run_read_api_body: observed
        ? "validated_body_observed"
        : "not_observed",
      trigger_run_read_api_body_elapsed_ms: elapsedMs,
      trigger_run_read_api_body_elapsed_capped: capped,
    }),
  };
}
