import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";
import {
  AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_EVENT,
  AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_VERSION,
  AGENT_START_BODY_SCAN_LIMIT_CODE_UNITS,
  AGENT_START_HTTP413_DIAGNOSTIC_EVENT,
  AGENT_START_HTTP413_DIAGNOSTIC_VERSION,
  getAgentStartBuildContext,
  type AgentPartialSaveBodyBucket,
  type AgentStartHeaderMarkerState,
  type AgentStartRequestBodyState,
  type AgentStartRequestIdState,
} from "@/lib/analytics/agent-start-privacy";
import {
  AGENT_START_REJECTION_HEADER,
  AGENT_START_TRIGGER_PAYLOAD_TOO_LARGE,
} from "@/lib/agent-start-response";
import { isPlatformRequestId } from "@/lib/platform-request-id";
import type { HttpErrorResponseMetadata } from "@/lib/utils";

/**
 * UTF-8 length of the exact serialized body, matching TextEncoder (a lone
 * surrogate becomes U+FFFD) without allocating an encoded copy. Null beyond
 * the diagnostic scan budget.
 */
export function countUtf8Bytes(
  value: string,
  limit = AGENT_START_BODY_SCAN_LIMIT_CODE_UNITS,
): number | null {
  if (value.length > limit) return null;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Never consumes or coerces a Blob, FormData, stream or other BodyInit. */
function measureBody(
  body: unknown,
):
  | { request_body_state: "measured"; request_body_utf8_bytes: number }
  | { request_body_state: Exclude<AgentStartRequestBodyState, "measured"> } {
  if (body === undefined || body === null) {
    return { request_body_state: "absent" };
  }
  if (typeof body !== "string") {
    return { request_body_state: "unmeasured_unsupported" };
  }
  const bytes = countUtf8Bytes(body);
  return bytes === null
    ? { request_body_state: "unmeasured_budget" }
    : { request_body_state: "measured", request_body_utf8_bytes: bytes };
}

const MIB = 1024 * 1024;

/**
 * Coarse UTF-8 size of the exact partial-save body handed to fetch. Every
 * UTF-16 code unit encodes to at least one byte, so a length above 8 MiB is
 * already above 8 MiB of UTF-8 and needs no scan.
 */
export function getAgentPartialSaveBodyBucket(
  body: unknown,
): AgentPartialSaveBodyBucket {
  if (typeof body !== "string") return "unknown";
  if (body.length > 8 * MIB) return "gt_8_mib";
  const bytes = countUtf8Bytes(body, 8 * MIB);
  if (bytes === null) return "unknown";
  if (bytes <= 4 * MIB) return "lte_4_mib";
  if (bytes <= 4.5 * MIB) return "gt_4_lte_4_5_mib";
  if (bytes <= 8 * MIB) return "gt_4_5_lte_8_mib";
  return "gt_8_mib";
}

const UNREADABLE = Symbol("unreadable");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readHeader(
  response: HttpErrorResponseMetadata,
  name: string,
): string | null | typeof UNREADABLE {
  try {
    const value = response.headers.get(name);
    return typeof value === "string" || value === null ? value : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

function classifyMarker(
  value: string | null | typeof UNREADABLE,
  known: string,
): AgentStartHeaderMarkerState {
  if (value === UNREADABLE) return "unreadable";
  if (value === null) return "absent";
  return value === known ? "known" : "other";
}

function readRequestId(response: HttpErrorResponseMetadata):
  | {
      platform_request_id_state: "valid";
      platform_request_id: string;
    }
  | {
      platform_request_id_state: Exclude<AgentStartRequestIdState, "valid">;
    } {
  const value = readHeader(response, "x-vercel-id");
  if (value === UNREADABLE) return { platform_request_id_state: "unreadable" };
  if (value === null) return { platform_request_id_state: "absent" };
  return isPlatformRequestId(value)
    ? { platform_request_id_state: "valid", platform_request_id: value }
    : { platform_request_id_state: "invalid" };
}

function currentIdentifiedOwner() {
  const owner = getPermittedAnalyticsUserId();
  return owner && getIdentifiedAnalyticsUserId() === owner ? owner : null;
}

export type AgentHttp413Diagnostic = {
  onHttpErrorResponse?: (response: HttpErrorResponseMetadata) => void;
  dispose: () => void;
};
export type AgentStartDiagnostic = AgentHttp413Diagnostic;

const NOOP: AgentHttp413Diagnostic = { dispose: () => {} };

/**
 * Observe one Agent start POST. Pass the exact body handed to fetch. Reports at
 * most one HTTP 413 for the permitted, identified owner at request start; any
 * owner change during the attempt, even back to the same owner, invalidates it.
 * Call `dispose` when the attempt settles. Never throws.
 */
export function beginAgentStartDiagnostic(body: unknown): AgentStartDiagnostic {
  return beginAgentHttp413Diagnostic("agent_start", body);
}

/**
 * The same one-attempt lifecycle for an Agent partial-save POST. Reports a
 * coarse body-size bucket instead of a byte count and reads no app marker.
 */
export function beginAgentPartialSaveDiagnostic(
  body: unknown,
): AgentHttp413Diagnostic {
  return beginAgentHttp413Diagnostic("partial_save", body);
}

function beginAgentHttp413Diagnostic(
  endpoint: "agent_start" | "partial_save",
  body: unknown,
): AgentHttp413Diagnostic {
  let cleanup: (() => void) | undefined;
  try {
    const owner = currentIdentifiedOwner();
    if (!owner) return NOOP;
    let requestBody = body;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const dispose = () => {
      active = false;
      requestBody = undefined;
      try {
        unsubscribe?.();
      } catch {
        // Diagnostics never affect the request cleanup.
      }
      unsubscribe = undefined;
    };
    cleanup = dispose;
    unsubscribe = subscribeAuthenticatedAnalytics(() => {
      try {
        // Same-owner identification notifies too; only a change invalidates.
        if (getPermittedAnalyticsUserId() !== owner) dispose();
      } catch {
        dispose();
      }
    });
    // Unreadable identity fails closed.
    const isCurrent = () => {
      try {
        return active && currentIdentifiedOwner() === owner;
      } catch {
        return false;
      }
    };
    if (!isCurrent()) {
      dispose();
      return NOOP;
    }

    return {
      onHttpErrorResponse: (response) => {
        if (!active) return;
        // One response per attempt: `finally` disposes whatever the outcome.
        try {
          if (response.status !== 413 || !isCurrent()) return;
          // Only the Agent start route sets an app rejection marker.
          const appMarker =
            endpoint === "agent_start"
              ? classifyMarker(
                  readHeader(response, AGENT_START_REJECTION_HEADER),
                  AGENT_START_TRIGGER_PAYLOAD_TOO_LARGE,
                )
              : null;
          const vercelError = classifyMarker(
            readHeader(response, "x-vercel-error"),
            "FUNCTION_PAYLOAD_TOO_LARGE",
          );
          const requestId = readRequestId(response);
          if (!isCurrent()) return;
          const report =
            appMarker === null
              ? {
                  event: AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_EVENT,
                  properties: {
                    agent_partial_save_http413_diagnostic_version:
                      AGENT_PARTIAL_SAVE_HTTP413_DIAGNOSTIC_VERSION,
                    http_status: 413,
                    request_body_utf8_bucket:
                      getAgentPartialSaveBodyBucket(requestBody),
                    vercel_error_state: vercelError,
                    ...requestId,
                    ...getAgentStartBuildContext(),
                  },
                }
              : {
                  event: AGENT_START_HTTP413_DIAGNOSTIC_EVENT,
                  properties: {
                    agent_start_http413_diagnostic_version:
                      AGENT_START_HTTP413_DIAGNOSTIC_VERSION,
                    http_status: 413,
                    ...measureBody(requestBody),
                    app_rejection_marker_state: appMarker,
                    vercel_error_state: vercelError,
                    ...requestId,
                    ...getAgentStartBuildContext(),
                    // Client attempts are not counted; join platform request totals.
                    attempt_denominator_kind: "unmeasured",
                  },
                };
          // Event identity only; never a request, chat, run or message ID.
          const attemptId: unknown = globalThis.crypto?.randomUUID?.();
          // Check the length before the pattern so no oversized value is scanned.
          if (
            typeof attemptId !== "string" ||
            attemptId.length !== 36 ||
            !UUID.test(attemptId) ||
            !isCurrent()
          )
            return;
          captureQueuedAuthenticatedEvent({ ...report, dedupeKey: attemptId });
        } catch {
          // Optional diagnostics never change the request, error or status.
        } finally {
          dispose();
        }
      },
      dispose,
    };
  } catch {
    // Never leave a registered listener or the body behind.
    try {
      cleanup?.();
    } catch {
      // Diagnostics never affect the request.
    }
    return NOOP;
  }
}
