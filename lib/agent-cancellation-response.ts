import { AGENT_CANCEL_ENDPOINT } from "@/lib/api/agent-endpoints";

/**
 * Bounded identity of the HTTP response behind a terminal Agent cancellation
 * rejection. Every field is a closed class or a strictly validated value; the
 * response URL, body and other headers are never retained. A claimed origin or
 * request ID is not verified platform identity; join it with platform logs.
 */
export type CancellationResponseReceipt = {
  cancellation_response_diagnostic_version: 1;
  cancellation_response_http_status?: number;
  cancellation_response_type:
    | "basic"
    | "cors"
    | "default"
    | "error"
    | "opaque"
    | "opaqueredirect"
    | "unavailable"
    | "unreadable";
  cancellation_response_redirected:
    "true" | "false" | "unavailable" | "unreadable";
  cancellation_response_url_origin:
    | "hackerai_production"
    | "signin_production"
    | "vercel_deployment"
    | "other"
    | "absent"
    | "unreadable";
  cancellation_response_endpoint:
    "agent_cancel" | "other" | "absent" | "unreadable";
  cancellation_response_platform_request_id_state:
    "valid" | "absent" | "invalid" | "unreadable";
  cancellation_response_platform_request_id?: string;
};

// Keyed by the unchanged thrown error, so callers never read error properties.
const receipts = new WeakMap<object, CancellationResponseReceipt>();

const RESPONSE_TYPES = new Set([
  "basic",
  "cors",
  "default",
  "error",
  "opaque",
  "opaqueredirect",
]);
const VERCEL_DEPLOYMENT_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/;
// One or two region hops, then the opaque request ID Vercel assigns.
const VERCEL_REQUEST_ID =
  /^(?:[a-z]{3}\d::){1,2}[a-z0-9]{4,8}-\d{10,17}-[a-f0-9]{8,32}$/;

const UNREADABLE = Symbol("unreadable");

function read<T>(getter: () => T): T | typeof UNREADABLE {
  try {
    return getter();
  } catch {
    return UNREADABLE;
  }
}

function classifyUrl(
  response: Response,
): Pick<
  CancellationResponseReceipt,
  "cancellation_response_url_origin" | "cancellation_response_endpoint"
> {
  const value = read(() => response.url);
  if (value === UNREADABLE)
    return {
      cancellation_response_url_origin: "unreadable",
      cancellation_response_endpoint: "unreadable",
    };
  if (typeof value !== "string" || value === "")
    return {
      cancellation_response_url_origin: "absent",
      cancellation_response_endpoint: "absent",
    };
  if (value.length > 8192)
    return {
      cancellation_response_url_origin: "unreadable",
      cancellation_response_endpoint: "unreadable",
    };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      cancellation_response_url_origin: "unreadable",
      cancellation_response_endpoint: "unreadable",
    };
  }
  const canonical =
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "";
  return {
    cancellation_response_url_origin: !canonical
      ? "other"
      : url.hostname === "hackerai.co"
        ? "hackerai_production"
        : url.hostname === "signin.hackerai.co"
          ? "signin_production"
          : VERCEL_DEPLOYMENT_HOST.test(url.hostname)
            ? "vercel_deployment"
            : "other",
    cancellation_response_endpoint:
      url.pathname === AGENT_CANCEL_ENDPOINT ? "agent_cancel" : "other",
  };
}

function readRequestId(
  response: Response,
): Pick<
  CancellationResponseReceipt,
  | "cancellation_response_platform_request_id_state"
  | "cancellation_response_platform_request_id"
> {
  const value = read(() => response.headers.get("x-vercel-id"));
  if (value === UNREADABLE)
    return { cancellation_response_platform_request_id_state: "unreadable" };
  if (value === null)
    return { cancellation_response_platform_request_id_state: "absent" };
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    VERCEL_REQUEST_ID.exec(value)?.[0] !== value
  )
    return { cancellation_response_platform_request_id_state: "invalid" };
  return {
    cancellation_response_platform_request_id_state: "valid",
    cancellation_response_platform_request_id: value,
  };
}

function snapshot(response: Response): CancellationResponseReceipt {
  const status = read(() => response.status);
  const type = read(() => response.type);
  const redirected = read(() => response.redirected);
  return {
    cancellation_response_diagnostic_version: 1,
    ...(typeof status === "number" &&
      Number.isInteger(status) &&
      (status === 0 || (status >= 100 && status <= 599)) && {
        cancellation_response_http_status: status,
      }),
    cancellation_response_type:
      type === UNREADABLE
        ? "unreadable"
        : typeof type === "string" && RESPONSE_TYPES.has(type)
          ? (type as CancellationResponseReceipt["cancellation_response_type"])
          : "unavailable",
    cancellation_response_redirected:
      redirected === UNREADABLE
        ? "unreadable"
        : typeof redirected === "boolean"
          ? redirected
            ? "true"
            : "false"
          : "unavailable",
    ...classifyUrl(response),
    ...readRequestId(response),
  };
}

/** Attach a receipt to a terminal rejection without reading the response body. */
export function recordCancellationResponse(
  error: object,
  response: Response,
): void {
  try {
    receipts.set(error, Object.freeze(snapshot(response)));
  } catch {
    // Diagnostics must never replace the rejection or its retry decision.
  }
}

/** Look up a receipt by identity; never reads properties of `error`. */
export function getCancellationResponseReceipt(
  error: unknown,
): CancellationResponseReceipt | undefined {
  return receipts.get(error as object);
}
