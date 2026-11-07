const ERROR_KINDS = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "OauthException",
  "BadRequestException",
  "AuthenticationException",
  "UnauthorizedException",
  "GenericServerException",
  "RateLimitExceededException",
  "NoApiKeyProvidedException",
  "ApiKeyRequiredException",
  "TokenRefreshError",
  "JWTExpired",
  "JWTInvalid",
  "JWTClaimValidationFailed",
  "JWSInvalid",
  "JOSEError",
]);

const ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "access_denied",
  "temporarily_unavailable",
  "server_error",
]);

type Description = {
  kind: string;
  status: number | null;
  statusShape: string;
  code: string;
};

const ABSENT: Description = {
  kind: "none",
  status: null,
  statusShape: "absent",
  code: "none",
};
const UNREADABLE: Description = {
  kind: "unreadable_error",
  status: null,
  statusShape: "unreadable",
  code: "unreadable",
};

function describe(value: unknown): Description {
  if (value === null || typeof value !== "object")
    return { ...ABSENT, kind: "non_error" };
  const record = value as Record<string, unknown>;
  const name = record.name;
  const status = record.status;
  const codes = [record.code, record.error];
  const code = codes.find(
    (candidate) => typeof candidate === "string" && ERROR_CODES.has(candidate),
  );
  const validStatus =
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599;
  return {
    kind:
      typeof name === "string" && ERROR_KINDS.has(name)
        ? name
        : name === undefined
          ? "object"
          : "other_error",
    status: validStatus ? status : null,
    statusShape:
      status == null
        ? "absent"
        : typeof status !== "number"
          ? "non_numeric"
          : !Number.isInteger(status)
            ? "non_integer"
            : validStatus
              ? "integer"
              : "out_of_range",
    code:
      typeof code === "string"
        ? code
        : codes.every((candidate) => candidate == null)
          ? "none"
          : "other",
  };
}

/** Fixed metadata only; this must never participate in refresh decisions. */
export function getRefreshFailureDiagnostics(error: unknown) {
  let root = UNREADABLE;
  let cause = UNREADABLE;
  try {
    root = describe(error);
    const firstCause =
      error !== null && typeof error === "object"
        ? (error as { cause?: unknown }).cause
        : undefined;
    cause =
      firstCause == null || firstCause === error
        ? ABSENT
        : describe(firstCause);
  } catch {
    // Optional getters/proxies cannot interrupt the existing auth callback.
  }
  return {
    auth_refresh_diagnostic_version: 1,
    auth_refresh_error_kind: root.kind,
    auth_refresh_error_status: root.status,
    auth_refresh_error_status_shape: root.statusShape,
    auth_refresh_error_code: root.code,
    auth_refresh_cause_kind: cause.kind,
    auth_refresh_cause_status: cause.status,
    auth_refresh_cause_status_shape: cause.statusShape,
    auth_refresh_cause_code: cause.code,
  };
}
