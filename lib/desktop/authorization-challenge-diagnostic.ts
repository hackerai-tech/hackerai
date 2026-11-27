/**
 * A support-only record of Vercel's pre-routing challenge of the native
 * Desktop authorization POST. The native app reports it on its own optional
 * channel only for an exact 403 with one exact `x-vercel-mitigated: challenge`
 * answering the canonical production origin, or an isolated localhost origin.
 *
 * The record holds the native capture time, the response's complete
 * `x-vercel-id` when it is one bounded value of ordinary ID bytes, and a closed
 * form of `Retry-After`. It never joins analytics, terminal output, the relay
 * or logs: the bridge uploads it once to this origin's own write-only endpoint,
 * which adds the fixed request context itself.
 */

export const AUTHORIZATION_CHALLENGE_DIAGNOSTIC_PATH =
  "/api/desktop/authorization-challenge-diagnostic";

/** Every valid record is far smaller; the endpoint rejects larger bodies. */
export const MAX_AUTHORIZATION_CHALLENGE_BODY_BYTES = 1024;

const UPLOAD_TIMEOUT_MS = 5_000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_RETRY_AFTER_SECONDS = 999_999_999;
/** Fri, 31 Dec 9999 23:59:59 GMT, the latest four-digit IMF-fixdate. */
const MAX_HTTP_DATE_MS = 253_402_300_799_000;

export type AuthorizationChallengeRequestId =
  { kind: "present"; value: string } | { kind: "absent" } | { kind: "invalid" };

export type AuthorizationChallengeRetryAfter =
  | { kind: "absent" }
  | { kind: "malformed" }
  | { kind: "seconds"; seconds: number }
  | { kind: "http_date"; unixMs: number };

export type NativeAuthorizationChallenge = {
  version: 1;
  capturedAtMs: number;
  requestId: AuthorizationChallengeRequestId;
  retryAfter: AuthorizationChallengeRetryAfter;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

const isBoundedInteger = (value: unknown, max: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max;

function parseRequestId(
  value: unknown,
): AuthorizationChallengeRequestId | null {
  if (!isRecord(value)) return null;
  if (value.kind === "present")
    return hasExactKeys(value, ["kind", "value"]) &&
      typeof value.value === "string" &&
      REQUEST_ID.test(value.value)
      ? { kind: "present", value: value.value }
      : null;
  if (
    (value.kind === "absent" || value.kind === "invalid") &&
    hasExactKeys(value, ["kind"])
  )
    return { kind: value.kind };
  return null;
}

function parseRetryAfter(
  value: unknown,
): AuthorizationChallengeRetryAfter | null {
  if (!isRecord(value)) return null;
  if (value.kind === "seconds")
    return hasExactKeys(value, ["kind", "seconds"]) &&
      isBoundedInteger(value.seconds, MAX_RETRY_AFTER_SECONDS)
      ? { kind: "seconds", seconds: value.seconds }
      : null;
  if (value.kind === "http_date")
    return hasExactKeys(value, ["kind", "unixMs"]) &&
      isBoundedInteger(value.unixMs, MAX_HTTP_DATE_MS)
      ? { kind: "http_date", unixMs: value.unixMs }
      : null;
  if (
    (value.kind === "absent" || value.kind === "malformed") &&
    hasExactKeys(value, ["kind"])
  )
    return { kind: value.kind };
  return null;
}

/** The exact v1 record, rebuilt from its own fields, or null. */
export function parseNativeAuthorizationChallenge(
  value: unknown,
): NativeAuthorizationChallenge | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "capturedAtMs",
      "requestId",
      "retryAfter",
    ]) ||
    value.version !== 1 ||
    !isBoundedInteger(value.capturedAtMs, Number.MAX_SAFE_INTEGER)
  )
    return null;
  const requestId = parseRequestId(value.requestId);
  const retryAfter = parseRetryAfter(value.retryAfter);
  if (!requestId || !retryAfter) return null;
  return {
    version: 1,
    capturedAtMs: value.capturedAtMs,
    requestId,
    retryAfter,
  };
}

/** Only the canonical production page or an isolated localhost page. */
export function isAuthorizationChallengeOrigin(origin: unknown): boolean {
  return (
    origin === "https://hackerai.co" ||
    (typeof origin === "string" &&
      /^https?:\/\/localhost(?::\d{1,5})?$/.test(origin))
  );
}

/**
 * One best-effort POST to this page's own origin with its own session, under
 * a short deadline. It never throws, retries, logs or reports its outcome, and
 * nothing waits for it.
 */
export function uploadNativeAuthorizationChallenge(
  record: NativeAuthorizationChallenge,
): void {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    deadline = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    fetch(AUTHORIZATION_CHALLENGE_DIAGNOSTIC_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      signal: controller.signal,
    })
      .catch(() => undefined)
      .finally(() => clearTimeout(deadline));
  } catch {
    // Diagnostics must never affect the command.
    clearTimeout(deadline);
  }
}
