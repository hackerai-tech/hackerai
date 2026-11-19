import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";
import {
  AGENT_START_BODY_SCAN_LIMIT_CODE_UNITS,
  AGENT_START_HTTP413_DIAGNOSTIC_EVENT,
  AGENT_START_HTTP413_DIAGNOSTIC_VERSION,
  getAgentStartBuildContext,
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

export type AgentStartDiagnostic = {
  onHttpErrorResponse?: (response: HttpErrorResponseMetadata) => void;
  dispose: () => void;
};

const NOOP: AgentStartDiagnostic = { dispose: () => {} };

/**
 * Observe one Agent start POST. Pass the exact body handed to fetch. Reports at
 * most one HTTP 413 for the permitted, identified owner at request start; any
 * owner change during the attempt, even back to the same owner, invalidates it.
 * Call `dispose` when the attempt settles. Never throws.
 */
export function beginAgentStartDiagnostic(body: unknown): AgentStartDiagnostic {
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
          const appMarker = classifyMarker(
            readHeader(response, AGENT_START_REJECTION_HEADER),
            AGENT_START_TRIGGER_PAYLOAD_TOO_LARGE,
          );
          const vercelError = classifyMarker(
            readHeader(response, "x-vercel-error"),
            "FUNCTION_PAYLOAD_TOO_LARGE",
          );
          const requestId = readRequestId(response);
          if (!isCurrent()) return;
          const measuredBody = measureBody(requestBody);
          const attemptId: unknown = globalThis.crypto?.randomUUID?.();
          // Check the length before the pattern so no oversized value is scanned.
          if (
            typeof attemptId !== "string" ||
            attemptId.length !== 36 ||
            !UUID.test(attemptId) ||
            !isCurrent()
          )
            return;
          captureQueuedAuthenticatedEvent({
            event: AGENT_START_HTTP413_DIAGNOSTIC_EVENT,
            properties: {
              agent_start_http413_diagnostic_version:
                AGENT_START_HTTP413_DIAGNOSTIC_VERSION,
              http_status: 413,
              ...measuredBody,
              app_rejection_marker_state: appMarker,
              vercel_error_state: vercelError,
              ...requestId,
              ...getAgentStartBuildContext(),
              // Client attempts are not counted; join platform request totals.
              attempt_denominator_kind: "unmeasured",
            },
            dedupeKey: attemptId,
          });
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
