import type { runs } from "@trigger.dev/sdk";
import {
  observeServiceTransport,
  type ServiceTransportObservation,
} from "../db/service-transport-observation";

// SDK4.7.7 forwards this core callback before its default payload/output
// preparation. Its public runs.retrieve options type omits the core callback;
// the installed-SDK contract test protects that version-sensitive boundary.
type ObservedReadOptions = NonNullable<Parameters<typeof runs.retrieve>[1]> & {
  onResponseBody: () => void;
};

const MAX_ELAPSED_MS = 60_000;
const MAX_REPORTED_REQUESTS = 16;
const TRANSPORT_STATES = new Set([
  "no_request_event",
  "request_created",
  "socket_assigned",
  "request_body_sent",
  "response_headers_received",
]);

const readClock = (): number | null => {
  try {
    const value = Date.now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * SDK4.7.7 sends runs.retrieve to `${baseURL}/api/v3/runs/${runId}`, where an
 * unscoped, unconfigured client uses TRIGGER_API_URL or its public default. The
 * app has no Trigger configure()/auth.withAuth() call; adding one requires
 * passing that same base URL here, or no_request_event no longer means the
 * observer saw no matching dispatch. Unsafe targets disable only diagnostics.
 */
function resolveRunReadTarget(runId: string, baseURL?: string): URL | null {
  try {
    const base =
      baseURL ?? process.env.TRIGGER_API_URL ?? "https://api.trigger.dev";
    const url = new URL(`${base.replace(/\/$/, "")}/api/v3/runs/${runId}`);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

const unavailableTransport: ServiceTransportObservation = {
  run: (operation) => operation(),
  snapshot: () => ({ transport_observation: "unavailable" }),
  finish: () => {},
};

/** Observe API-body validation without reading the body, span or response.
 * Absence cannot distinguish network/retry/schema work or a missing callback.
 * Transport state is the latest matching dispatch only: several dispatches can
 * be SDK retries or redirects, and no event cannot prove a request never left.
 */
export function createTriggerRunReadDiagnostics({
  runId,
  baseURL,
}: {
  runId: string;
  /** Only for a caller that explicitly configures the SDK's base URL. */
  baseURL?: string;
}) {
  const startedAt = readClock();
  let observed = false;
  let elapsedMs: number | null = null;
  let capped = false;
  let transport = unavailableTransport;
  try {
    const target = resolveRunReadTarget(runId, baseURL);
    if (target) transport = observeServiceTransport(target, { method: "GET" });
  } catch {
    // Diagnostics are optional and must not prevent the original read.
  }
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
  const transportSnapshot = () => {
    try {
      const fields = transport.snapshot();
      const state = fields.transport_observation;
      const count = fields.transport_request_count;
      if (typeof state !== "string" || !TRANSPORT_STATES.has(state))
        throw new Error("unavailable");
      const requests =
        typeof count === "number" && Number.isSafeInteger(count) && count > 0
          ? count
          : 0;
      return {
        trigger_run_read_transport_state: state,
        trigger_run_read_transport_request_count: Math.min(
          MAX_REPORTED_REQUESTS,
          requests,
        ),
        trigger_run_read_transport_request_count_capped:
          requests > MAX_REPORTED_REQUESTS,
      };
    } catch {
      return {
        trigger_run_read_transport_state: "unavailable",
        trigger_run_read_transport_request_count: 0,
        trigger_run_read_transport_request_count_capped: false,
      };
    }
  };
  return {
    requestOptions,
    /** Invoke the read exactly once and return its own result or error. */
    run<T>(operation: () => T): T {
      let entered = false;
      let failed = false;
      let result: T | undefined;
      let error: unknown;
      try {
        transport.run(() => {
          if (entered) return;
          entered = true;
          try {
            result = operation();
          } catch (thrown) {
            failed = true;
            error = thrown;
          }
        });
      } catch {
        // An observer failure cannot replace the operation's own outcome.
      }
      if (!entered) return operation();
      if (failed) throw error;
      return result as T;
    },
    finish: () => {
      try {
        transport.finish();
      } catch {
        // Optional observer failures must not replace the read's outcome.
      }
    },
    snapshot: () => ({
      trigger_run_read_diagnostic_version: 1 as const,
      trigger_run_read_api_body: observed
        ? "validated_body_observed"
        : "not_observed",
      trigger_run_read_api_body_elapsed_ms: elapsedMs,
      trigger_run_read_api_body_elapsed_capped: capped,
      trigger_run_read_transport_diagnostic_version: 1 as const,
      ...transportSnapshot(),
    }),
  };
}
