import type { ServiceProofObservation } from "./service-proof";

// Closed attribution for native backend errors in an SDK application-error
// response. A kind or label describes this response's public text only: it
// does not prove which execution (or a nested call) produced it, key
// configuration, scope or root cause.

// Convex's native receipt, which leads both redacted and unredacted uncaught
// errors. It qualifies the response for safe caller/request-ID attribution
// whatever follows; typed ConvexErrors and other messages stay unobserved.
const NATIVE_RECEIPT = /^\[Request ID: [a-f0-9]{16}\] Server Error(?:\n|$)/;
// The two evidenced public first lines. Anything else is `unclassified`, so a
// hidden or reworded marker loses only the kind, never the attribution. Read
// from a bounded prefix; the markers end long before it.
const MESSAGE_PREFIX_CHARS = 256;
const KNOWN_FIRST_LINE =
  /^Uncaught Error: (?:(Unauthorized: Invalid service request)(?=\n|$)|(Too many bytes read in a single function execution)(?=[ .\n]|$))/;

export type PublicBackendErrorKind =
  "invalid_service_request" | "read_byte_limit" | "unclassified";

/** Only an application error (no ConvexError data) led by a native receipt. */
export function classifyPublicBackendError(result: {
  errorMessage?: unknown;
  errorData?: unknown;
}): PublicBackendErrorKind | undefined {
  if (result.errorData !== undefined || typeof result.errorMessage !== "string")
    return undefined;
  const head = result.errorMessage.slice(0, MESSAGE_PREFIX_CHARS);
  const receipt = NATIVE_RECEIPT.exec(head);
  if (!receipt) return undefined;
  const known = KNOWN_FIRST_LINE.exec(head.slice(receipt[0].length));
  if (known?.[1]) return "invalid_service_request";
  return known?.[2] ? "read_byte_limit" : "unclassified";
}

// Convex keeps 256 lines per execution and may drop later lines, so a receipt
// is not proof that every backend line was retained. A much longer array is
// not a known SDK shape and is unsupported rather than scanned without limit.
const MAX_LOG_LINES = 300;
const MAX_LINE_CHARS = 256;

// A Record makes a new producer label a type error until it is listed here.
const LABELS: Record<ServiceProofObservation, true> = {
  credential_not_string: true,
  proof_malformed: true,
  proof_expired: true,
  proof_future: true,
  verification_failed: true,
};

// convexLogger.warn's `service_proof_rejected` line (convex/lib/serviceFunctions.ts)
// as delivered to callers: `[WARN] ` plus the single-quoted JSON argument,
// the rendering verified on Preview. Other renderings are unsupported.
const PRODUCER =
  /^\[WARN\] '?\{"level":"warn","event":"service_proof_rejected"[,}]/;
const ACCEPTED = new RegExp(
  `^\\[WARN\\] '\\{"level":"warn","event":"service_proof_rejected",` +
    `"timestamp":"\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z",` +
    `"diagnostic_version":1,` +
    `"public_input_observation":"(${Object.keys(LABELS).join("|")})"\\}'$`,
);

type LogLineStatus =
  "unavailable" | "not_found" | "recognized" | "unsupported" | "ambiguous";

function observeProofRejectionLines(lines: unknown) {
  const observe = (
    status: LogLineStatus,
    extra: Record<string, unknown> = {},
  ) => ({ service_proof_log_lines: status, ...extra });
  // Absence means this caller received no log receipt, not a backend cause.
  if (!Array.isArray(lines)) return observe("unavailable");
  // Separates an empty receipt from lines in a rendering this reader lacks.
  const received = { log_line_count: lines.length };
  if (lines.length > MAX_LOG_LINES) return observe("unsupported", received);
  const labels = new Set<string>();
  let accepted = 0;
  let unsupported = 0;
  for (const line of lines) {
    if (typeof line !== "string") {
      unsupported++;
      continue;
    }
    if (!PRODUCER.test(line.slice(0, 64))) continue;
    const label =
      line.length <= MAX_LINE_CHARS ? ACCEPTED.exec(line)?.[1] : undefined;
    if (label) {
      accepted++;
      labels.add(label);
    } else unsupported++;
  }
  const counts = { ...received, service_proof_rejection_lines: accepted };
  if (unsupported === 0 && labels.size === 0)
    return observe("not_found", counts);
  if (unsupported === 0 && labels.size === 1)
    return observe("recognized", {
      ...counts,
      public_input_observation: [...labels][0],
    });
  return observe(labels.size === 0 ? "unsupported" : "ambiguous", counts);
}

/**
 * Closed fields for a qualified native backend error, or undefined for every
 * other response. A redacted guard can still carry the producer's line, so
 * unclassified errors read it too; a known read limit is not a proof
 * rejection and does not. Absent, unsupported or conflicting log lines never
 * default to a proof label.
 */
export function observeServiceError(result: {
  errorMessage?: unknown;
  errorData?: unknown;
  logLines?: unknown;
}) {
  const kind = classifyPublicBackendError(result);
  if (!kind) return undefined;
  return {
    service_error_diagnostic_version: 1,
    public_backend_error_kind: kind,
    ...(kind === "read_byte_limit"
      ? {}
      : observeProofRejectionLines(result.logLines)),
  };
}
