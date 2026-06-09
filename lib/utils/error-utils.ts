/**
 * Extracts a readable error message from any error type.
 */
export const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    return typeof msg === "string" ? msg : JSON.stringify(msg);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

const truncate = (str: string, max: number): string => {
  return str.length > max ? str.slice(0, max) + "…" : str;
};

const SENSITIVE_KEYS = new Set([
  "requestBodyValues",
  "prompt",
  "messages",
  "content",
  "text",
]);

const OPENROUTER_DETAIL_MAX_LENGTH = 500;

const parseJsonObject = (
  value: string,
): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const collectErrorSources = (
  source: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown[] => {
  if (!isRecord(source) || depth > 3 || seen.has(source)) return [source];
  seen.add(source);

  const sources: unknown[] = [source];
  for (const key of ["error", "cause"] as const) {
    const nested = source[key];
    if (nested !== undefined) {
      sources.push(...collectErrorSources(nested, seen, depth + 1));
    }
  }

  const errors = source.errors;
  if (Array.isArray(errors)) {
    for (const nested of errors.slice(0, 5)) {
      sources.push(...collectErrorSources(nested, seen, depth + 1));
    }
  }

  return sources;
};

const getOpenRouterPayload = (
  source: unknown,
): Record<string, unknown> | null => {
  if (!isRecord(source)) return null;
  const anySource = source;

  if (anySource.data && typeof anySource.data === "object") {
    return anySource.data as Record<string, unknown>;
  }

  if (
    isRecord(anySource.error) &&
    ("code" in anySource.error || "metadata" in anySource.error)
  ) {
    return anySource;
  }

  if (typeof anySource.responseBody === "string") {
    return parseJsonObject(anySource.responseBody) ?? null;
  }

  return null;
};

const getOpenRouterProviderInfo = (
  source: unknown,
): Record<string, unknown> => {
  const payloads = collectErrorSources(source)
    .map(getOpenRouterPayload)
    .filter((payload): payload is Record<string, unknown> => payload !== null);
  if (payloads.length === 0) return {};

  const details: Record<string, unknown> = {};
  for (const payload of payloads) {
    const id = pickBodyId(payload);
    if (id && details.openrouterGenerationId === undefined) {
      details.openrouterGenerationId = id;
    }

    const nested = isRecord(payload.error) ? payload.error : undefined;
    if (!nested) continue;

    if (
      details.providerErrorCode === undefined &&
      (typeof nested.code === "number" || typeof nested.code === "string")
    ) {
      details.providerErrorCode = nested.code;
    }
    if (
      details.providerErrorMessage === undefined &&
      typeof nested.message === "string" &&
      nested.message.length > 0
    ) {
      details.providerErrorMessage = truncate(
        nested.message,
        OPENROUTER_DETAIL_MAX_LENGTH,
      );
    }

    const metadata = isRecord(nested.metadata) ? nested.metadata : undefined;
    if (!metadata) continue;

    if (
      details.providerName === undefined &&
      typeof metadata.provider_name === "string"
    ) {
      details.providerName = metadata.provider_name;
    }
    if (
      details.providerRawError === undefined &&
      typeof metadata.raw === "string" &&
      metadata.raw.length > 0
    ) {
      details.providerRawError = truncate(
        metadata.raw,
        OPENROUTER_DETAIL_MAX_LENGTH,
      );
    }
  }

  return details;
};

/**
 * Removes sensitive user data from provider error objects.
 * Fields containing user prompts/messages are completely removed.
 * Uses WeakSet to guard against circular references.
 */
const removeSensitiveData = (data: unknown): unknown => {
  const seen = new WeakSet<object>();

  const recurse = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;

    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(recurse);
    }

    const obj = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(key)) {
        continue;
      }
      if (val && typeof val === "object") {
        cleaned[key] = recurse(val);
      } else {
        cleaned[key] = val;
      }
    }

    return cleaned;
  };

  return recurse(data);
};

/**
 * Extracts structured error details for logging to PostHog or other services.
 * Handles both standard Error objects and provider-specific error formats (AI SDK, etc.)
 * Sensitive user data (prompts, messages) is removed from the output.
 */
export const extractErrorDetails = (
  error: unknown,
): Record<string, unknown> => {
  const sources = collectErrorSources(error);
  const err = sources.find((source) => source instanceof Error) as
    | Error
    | undefined;
  const records = sources.filter(isRecord);
  const primaryRecord = records[0];

  const details: Record<string, unknown> = {
    errorName:
      err?.name ||
      (typeof primaryRecord?.name === "string"
        ? primaryRecord.name
        : "UnknownError"),
    errorMessage: getErrorMessage(error),
  };

  // Add stack trace if available
  if (err?.stack) {
    details.errorStack = err.stack;
  }

  // Extract provider-specific error details (AI SDK format). Walk common
  // wrapper fields so stream/UI wrappers do not hide APICallError diagnostics.
  for (const source of records) {
    if (details.statusCode === undefined && "statusCode" in source) {
      details.statusCode = source.statusCode;
    }
    if (details.providerUrl === undefined && "url" in source) {
      details.providerUrl = source.url;
    }
    if (details.responseBody === undefined && "responseBody" in source) {
      details.responseBody = removeSensitiveData(source.responseBody);
    }
    if (details.isRetryable === undefined && "isRetryable" in source) {
      details.isRetryable = source.isRetryable;
    }
    if (details.providerData === undefined && "data" in source) {
      details.providerData = removeSensitiveData(source.data);
    }
    if (details.cause === undefined && "cause" in source && source.cause) {
      details.cause = getErrorMessage(source.cause);
    }
    if (details.errorCode === undefined && "code" in source) {
      details.errorCode = source.code;
    }
  }

  Object.assign(details, getOpenRouterProviderInfo(error));

  return details;
};

export type ProviderErrorCategory =
  | "rate_limited"
  | "provider_5xx"
  | "provider_4xx"
  | "stream_terminated"
  | "timeout"
  | "unknown";

const parseHttpStatus = (value: unknown): number | undefined => {
  const code =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : undefined;

  return code != null && Number.isInteger(code) && code >= 400 && code <= 599
    ? code
    : undefined;
};

export const getProviderStatusCode = (
  details: Record<string, unknown>,
): number | undefined => {
  const statusCode = parseHttpStatus(details.statusCode);
  if (statusCode != null) return statusCode;

  for (const key of ["providerErrorCode", "errorCode"] as const) {
    const code = parseHttpStatus(details[key]);
    if (code != null) return code;
  }

  return undefined;
};

export const getProviderErrorCategory = (
  details: Record<string, unknown>,
): ProviderErrorCategory => {
  const statusCode =
    parseHttpStatus(details.statusCode) ??
    parseHttpStatus(details.providerErrorCode);
  if (statusCode === 429) return "rate_limited";
  if (statusCode != null && statusCode >= 500) return "provider_5xx";
  if (statusCode != null && statusCode >= 400) return "provider_4xx";

  const message = [
    details.errorMessage,
    details.providerErrorMessage,
    details.providerRawError,
    details.cause,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (
    /terminated|aborted|abort|network connection lost|connection (?:reset|closed|lost)|socket hang up|unexpected eof/i.test(
      message,
    )
  ) {
    return "stream_terminated";
  }
  if (/timeout|timed out/i.test(message)) return "timeout";

  const fallbackStatusCode = parseHttpStatus(details.errorCode);
  if (fallbackStatusCode === 429) return "rate_limited";
  if (fallbackStatusCode != null && fallbackStatusCode >= 500)
    return "provider_5xx";
  if (fallbackStatusCode != null && fallbackStatusCode >= 400)
    return "provider_4xx";

  return "unknown";
};

export const isProviderStreamTerminatedError = (error: unknown): boolean =>
  getProviderErrorCategory(extractErrorDetails(error)) === "stream_terminated";

export interface ProviderAttempt {
  status_code?: number;
  message: string;
  error_name?: string;
  request_id?: string;
  provider_name?: string;
}

const REQUEST_ID_HEADERS = [
  // OpenRouter exposes its generation id as `X-Generation-Id` on every
  // response where a generation was attempted (CORS-exposed). Prefer it
  // over cf-ray so we get a queryable id even when the error body isn't
  // parsed into `data` / `responseBody`.
  "x-generation-id",
  "request-id",
  "x-request-id",
  "cf-ray",
  "x-amzn-requestid",
];

const pickBodyId = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { id?: unknown; request_id?: unknown };
  // Accept any non-empty string from `id` — OpenRouter uses `gen-…` today,
  // but locking to that prefix would silently drop a `req-…` id and fall
  // back to cf-ray, which is the opposite of what this function is for.
  if (typeof b.id === "string" && b.id.length > 0) return b.id;
  if (typeof b.request_id === "string" && b.request_id.length > 0)
    return b.request_id;
  return undefined;
};

const extractRequestId = (error: unknown): string | undefined => {
  if (!isRecord(error)) return undefined;
  const e = error as {
    responseHeaders?: Record<string, unknown>;
    data?: unknown;
    responseBody?: unknown;
  };

  const fromData = pickBodyId(e.data);
  if (fromData) return fromData;

  if (typeof e.responseBody === "string") {
    try {
      const fromBody = pickBodyId(JSON.parse(e.responseBody));
      if (fromBody) return fromBody;
    } catch {
      // responseBody isn't JSON; fall through to headers
    }
  }

  const headers = e.responseHeaders;
  if (!headers || typeof headers !== "object") return undefined;
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  for (const key of REQUEST_ID_HEADERS) {
    const value = lower[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

const toAttempt = (error: unknown): ProviderAttempt => {
  const anyError = isRecord(error) ? error : {};
  const providerInfo = getOpenRouterProviderInfo(error);
  const statusCode =
    typeof anyError.statusCode === "number"
      ? anyError.statusCode
      : typeof anyError.status === "number"
        ? anyError.status
        : undefined;
  const errorName =
    error instanceof Error
      ? error.name
      : typeof anyError.name === "string"
        ? (anyError.name as string)
        : undefined;
  return {
    status_code: statusCode,
    message: getErrorMessage(error),
    error_name: errorName,
    request_id: extractRequestId(error),
    provider_name:
      typeof providerInfo.providerName === "string"
        ? providerInfo.providerName
        : undefined,
  };
};

/**
 * Decompose an AI SDK `RetryError` (or anything with an `errors[]` array of
 * attempt errors) into per-attempt records. Returns undefined when the error
 * does not carry attempt history, so callers can fall back to single-error
 * logging.
 */
export const extractRetryAttempts = (
  error: unknown,
): ProviderAttempt[] | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  return errors.map(toAttempt);
};

/**
 * Converts a provider error into a user-friendly message.
 *
 * Extracts details from the AI SDK `APICallError` shape:
 *   - `statusCode`          — HTTP status (e.g. 429)
 *   - `data.error.message`  — OpenRouter's provider error message
 *   - `data.error.metadata.provider_name` — e.g. "Google", "Anthropic"
 *   - `data.error.metadata.raw` — raw detail from the underlying provider
 *   - `responseBody`        — fallback when `data` isn't parsed
 *
 * Output format:
 *   "<friendly explanation>\n\nDetails: <provider_name> returned <status>: <detail>"
 */
export const getUserFriendlyProviderError = (error: unknown): string => {
  const statusCode = extractStatusCode(error);
  const { providerName, detail } = extractProviderDetails(error);

  // Friendly summary based on status code
  const summary = getStatusSummary(statusCode);

  // Build "Details: …" line from whatever specifics we have
  const detailParts: string[] = [];
  if (providerName) detailParts.push(providerName);
  if (statusCode) detailParts.push(`HTTP ${statusCode}`);
  if (detail) detailParts.push(detail);

  if (detailParts.length > 0) {
    return `${summary}\n\nDetails: ${detailParts.join(" — ")}`;
  }
  return summary;
};

function getStatusSummary(statusCode: number | undefined): string {
  switch (statusCode) {
    case 429:
      return "The model is temporarily rate limited. Please wait a moment and try again.";
    case 403:
      return "Access to this model was denied by the provider. Please try a different model.";
    case 400:
      return "The model could not process this request. Please try again or use a different model.";
    case 408:
    case 504:
      return "The model took too long to respond. Please try again.";
    case 500:
    case 502:
    case 503:
      return "The model provider encountered a server error. Please try again or switch to a different model.";
    default:
      return "An error occurred while generating a response. Please try again.";
  }
}

/**
 * Pulls the most specific error detail from the AI SDK / OpenRouter error,
 * preferring `metadata.raw` > `data.error.message` > `responseBody` snippet.
 */
function extractProviderDetails(error: unknown): {
  providerName?: string;
  detail?: string;
} {
  if (!error || typeof error !== "object") return {};

  const anyError = error as Record<string, unknown>;
  let providerName: string | undefined;
  let detail: string | undefined;

  // OpenRouter nested format: data.error { message, metadata { provider_name, raw } }
  if (anyError.data && typeof anyError.data === "object") {
    const data = anyError.data as Record<string, unknown>;
    if (data.error && typeof data.error === "object") {
      const nested = data.error as Record<string, unknown>;

      if (nested.metadata && typeof nested.metadata === "object") {
        const meta = nested.metadata as Record<string, unknown>;
        if (typeof meta.provider_name === "string") {
          providerName = meta.provider_name;
        }
        // metadata.raw has the most specific upstream error
        if (typeof meta.raw === "string" && meta.raw.length > 0) {
          detail = truncate(meta.raw, 300);
        }
      }

      // Fall back to data.error.message
      if (!detail && typeof nested.message === "string") {
        detail = truncate(nested.message, 300);
      }
    }
  }

  // Last resort: try to extract a message from the raw responseBody string
  if (!detail && typeof anyError.responseBody === "string") {
    detail = extractMessageFromResponseBody(anyError.responseBody);
  }

  return { providerName, detail };
}

/** Extract HTTP status code from AI SDK error objects. */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const anyError = error as Record<string, unknown>;

  // Direct statusCode property (AI SDK APICallError)
  if (typeof anyError.statusCode === "number") {
    return anyError.statusCode;
  }

  // Nested in data.error.code (OpenRouter format)
  if (
    anyError.data &&
    typeof anyError.data === "object" &&
    "error" in anyError.data
  ) {
    const nested = (anyError.data as Record<string, unknown>).error as
      | Record<string, unknown>
      | undefined;
    if (nested && typeof nested.code === "number") {
      return nested.code;
    }
  }

  // HTTP status property
  if (typeof anyError.status === "number") {
    return anyError.status;
  }

  return undefined;
}

/** Try to pull an error message from a JSON response body string. */
function extractMessageFromResponseBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message;
    if (typeof msg === "string" && msg.length > 0) {
      return truncate(msg, 300);
    }
  } catch {
    // Not JSON — return a trimmed snippet if it's short enough to be useful
    const trimmed = body.trim();
    if (trimmed.length > 0 && trimmed.length <= 300) {
      return trimmed;
    }
  }
  return undefined;
}
