import {
  APICallError,
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { abortableDelay } from "@/lib/utils/abortable-delay";

type Model = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0]["model"];

/**
 * Provider error codes safe for low-cardinality telemetry. Matched exactly
 * against `error.code` or `error.type`; never derived from message text.
 */
const SAFE_PROVIDER_ERROR_CODES = [
  "capacity_exceeded",
  "context_length_exceeded",
  "rate_limit_exceeded",
  "too_many_tool_calls",
] as const;
export type SafeProviderErrorCode = (typeof SAFE_PROVIDER_ERROR_CODES)[number];
const MAX_PARSED_RESPONSE_BODY_LENGTH = 32_768;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isSafeCode = (value: unknown): value is SafeProviderErrorCode =>
  SAFE_PROVIDER_ERROR_CODES.includes(value as SafeProviderErrorCode);

/** Exact allowlisted code from an OpenAI-compatible error body; never its text. */
export function getSafeProviderErrorCode(
  error: unknown,
): SafeProviderErrorCode | undefined {
  if (!isRecord(error)) return;
  const read = (payload: unknown) => {
    const nested = isRecord(payload) ? payload.error : undefined;
    if (!isRecord(nested)) return;
    if (isSafeCode(nested.code)) return nested.code;
    if (isSafeCode(nested.type)) return nested.type;
  };
  const fromData = read(error.data);
  if (fromData) return fromData;
  if (
    typeof error.responseBody !== "string" ||
    error.responseBody.length >= MAX_PARSED_RESPONSE_BODY_LENGTH
  )
    return;
  try {
    return read(JSON.parse(error.responseBody));
  } catch {
    return; // Not JSON.
  }
}

/** Exact Inference HTTP rejections this module and its callers recover from. */
export function classifyInferenceRejection(
  error: unknown,
): "context_length_exceeded" | "capacity_exceeded" | undefined {
  if (!APICallError.isInstance(error)) return;
  const code = getSafeProviderErrorCode(error);
  if (error.statusCode === 400 && code === "context_length_exceeded")
    return code;
  if (error.statusCode === 429 && code === "capacity_exceeded") return code;
}

export const RETRY_AFTER_CEILING_MS = 2_000;

/** Retry-After as delta-seconds or an HTTP-date, in milliseconds from `now`. */
export function parseRetryAfterMs(
  value: string | undefined,
  now: number,
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  // Only day-name dates: Date.parse also accepts bare numbers such as "1.5".
  if (!/^[A-Za-z]{3}/.test(trimmed)) return;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

const getHeader = (
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined => {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name) return value;
};

const PROVIDER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type InferenceAttemptDiagnostic = {
  event: "inference_request_attempt";
  diagnostic_version: 1;
  operation: "stream" | "generate";
  /** 1 is the caller's request; 2 is this module's single owned retry. */
  attempt: 1 | 2;
  outcome: "rejected" | "accepted" | "cancelled";
  retry?:
    "scheduled" | "not_retryable" | "retry_after_exceeds_ceiling" | "exhausted";
  retry_delay_ms?: number;
  status_code?: number;
  error_code?: SafeProviderErrorCode;
  provider_request_id?: string;
  /** Serialized request bytes, only for exact context-length rejections. */
  request_body_bytes?: number;
};

/** Content-free projection: no bodies, prompts, headers or error text. */
function describeFailure(error: unknown) {
  if (!APICallError.isInstance(error)) return {};
  const status = error.statusCode;
  const code = getSafeProviderErrorCode(error);
  const requestId = ["x-inference-id", "x-request-id"]
    .map((header) => getHeader(error.responseHeaders, header))
    .find((id) => id && PROVIDER_REQUEST_ID.test(id));
  let requestBodyBytes: number | undefined;
  if (code === "context_length_exceeded" && error.statusCode === 400) {
    try {
      // The adapter sends exactly JSON.stringify(requestBodyValues).
      const serialized = JSON.stringify(error.requestBodyValues);
      if (serialized !== undefined)
        requestBodyBytes = new TextEncoder().encode(serialized).byteLength;
    } catch {
      // Diagnostics are optional.
    }
  }
  return {
    ...(typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599 && { status_code: status }),
    ...(code && { error_code: code }),
    ...(requestId && { provider_request_id: requestId }),
    ...(requestBodyBytes !== undefined && {
      request_body_bytes: requestBodyBytes,
    }),
  };
}

const logAttempt = (diagnostic: InferenceAttemptDiagnostic) => {
  const line = JSON.stringify(diagnostic);
  if (diagnostic.outcome === "accepted") console.info(line);
  else console.warn(line);
};

/** Keep these classifications usable by outer recovery and safe to log. */
function terminalRejection(
  error: APICallError,
  code: NonNullable<ReturnType<typeof classifyInferenceRejection>>,
) {
  return new APICallError({
    message: code,
    url: error.url,
    requestBodyValues: undefined,
    statusCode: error.statusCode,
    data: { error: { code } },
    isRetryable: false,
  });
}

/**
 * Inference-only: one cancellation-aware, jittered retry when the provider
 * rejects a request for capacity before dispatch. Applies only before a result
 * exists, so a published stream part is never replayed. Streamed errors and
 * all other failures keep their existing handling.
 */
export function withInferenceRequestRecovery(
  model: Model,
  options: {
    random?: () => number;
    observe?: (diagnostic: InferenceAttemptDiagnostic) => void;
  } = {},
): Model {
  const random = options.random ?? Math.random;
  const observe = options.observe ?? logAttempt;
  const report = (diagnostic: InferenceAttemptDiagnostic) => {
    try {
      observe(diagnostic);
    } catch {
      // Observability must not affect provider calls.
    }
  };
  async function call<T>(
    operation: InferenceAttemptDiagnostic["operation"],
    signal: AbortSignal | undefined,
    request: () => PromiseLike<T>,
  ): Promise<T> {
    const base = {
      event: "inference_request_attempt",
      diagnostic_version: 1,
      operation,
    } as const;
    try {
      return await request();
    } catch (error) {
      if (signal?.aborted) throw error;
      const rejection = classifyInferenceRejection(error);
      const capacity = rejection === "capacity_exceeded";
      let delay: number | undefined;
      if (capacity) {
        const retryAfter = parseRetryAfterMs(
          getHeader((error as APICallError).responseHeaders, "retry-after"),
          Date.now(),
        );
        delay =
          retryAfter !== undefined && retryAfter > RETRY_AFTER_CEILING_MS
            ? undefined
            : Math.max(retryAfter ?? 0, 1000 + Math.floor(random() * 1000));
      }
      report({
        ...base,
        attempt: 1,
        outcome: "rejected",
        retry: !capacity
          ? "not_retryable"
          : delay === undefined
            ? "retry_after_exceeds_ceiling"
            : "scheduled",
        ...(delay !== undefined && { retry_delay_ms: delay }),
        ...describeFailure(error),
      });
      if (!rejection) throw error;
      if (delay === undefined)
        throw terminalRejection(error as APICallError, rejection);
      try {
        await abortableDelay(delay, signal);
        signal?.throwIfAborted();
      } catch (abortError) {
        report({ ...base, attempt: 2, outcome: "cancelled" });
        throw abortError;
      }
      try {
        const result = await request();
        report({
          ...base,
          attempt: 2,
          // For streaming this is HTTP acceptance; the stream may still fail.
          outcome: "accepted",
          retry_delay_ms: delay,
        });
        return result;
      } catch (retryError) {
        if (signal?.aborted) throw retryError;
        report({
          ...base,
          attempt: 2,
          outcome: "rejected",
          retry: "exhausted",
          ...describeFailure(retryError),
        });
        const terminal = classifyInferenceRejection(retryError);
        throw terminal
          ? terminalRejection(retryError as APICallError, terminal)
          : retryError;
      }
    }
  }
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: ({ doStream, params }) =>
        call("stream", params.abortSignal, doStream),
      wrapGenerate: ({ doGenerate, params }) =>
        call("generate", params.abortSignal, doGenerate),
    },
  });
}
