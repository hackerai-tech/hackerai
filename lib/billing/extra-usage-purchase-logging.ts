type ExtraUsagePurchaseLogLevel = "info" | "warn" | "error";

type ExtraUsagePurchaseLogArgs = {
  route: "/api/extra-usage/confirm" | "/api/extra-usage/webhook";
  requestHeaders: Headers;
  userId?: string;
  amountDollars?: number;
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  stripeInvoiceId?: string;
  paymentStatus?: string | null;
  result?: string;
  reason?: string;
  error?: unknown;
};

const MAX_ERROR_MESSAGE_LENGTH = 300;
const JSON_SECRET_PATTERN =
  /(["'])(serviceKey|service_key|apiKey|api_key|authorization|cookie|password|secret|token)\1\s*:\s*(["'])(?:(?!\3).)*\3/gi;
const ASSIGNMENT_SECRET_PATTERN =
  /\b(serviceKey|service_key|apiKey|api_key|cookie|password|secret|token)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}]+)/gi;
const AUTHORIZATION_BEARER_PATTERN =
  /\bAuthorization\s*[:=]\s*Bearer\s+[^\s,}]+/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function requestId(headers: Headers): string | undefined {
  return (
    headers.get("x-vercel-id") ??
    headers.get("x-request-id") ??
    headers.get("cf-ray") ??
    undefined
  );
}

function sanitizeErrorMessage(message: string): string | undefined {
  const sanitized = message
    .replace(AUTHORIZATION_BEARER_PATTERN, "Authorization: Bearer [redacted]")
    .replace(JSON_SECRET_PATTERN, (_match, quote, key) => {
      return `${quote}${key}${quote}: "[redacted]"`;
    })
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, (match) => {
      const separatorIndex = Math.max(match.indexOf(":"), match.indexOf("="));
      if (separatorIndex === -1) return "[redacted]";
      return `${match.slice(0, separatorIndex + 1)} [redacted]`;
    })
    .split("\n", 1)[0]
    .trim();

  return sanitized ? sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH) : undefined;
}

function errorDetails(error: unknown): {
  error_name?: string;
  error_message?: string;
} {
  if (!error) return {};

  if (error instanceof Error) {
    return {
      error_name: error.name || undefined,
      error_message: sanitizeErrorMessage(error.message),
    };
  }

  return {
    error_message: sanitizeErrorMessage(String(error)),
  };
}

export function logExtraUsagePurchase(
  level: ExtraUsagePurchaseLogLevel,
  event: string,
  args: ExtraUsagePurchaseLogArgs,
): void {
  const logFields = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "zhacker-web",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    route: args.route,
    request_id: requestId(args.requestHeaders),
    user_id: args.userId,
    amount_dollars: args.amountDollars,
    stripe_checkout_session_id: args.stripeCheckoutSessionId,
    stripe_payment_intent_id: args.stripePaymentIntentId,
    stripe_invoice_id: args.stripeInvoiceId,
    payment_status: args.paymentStatus,
    result: args.result,
    reason: args.reason,
    ...errorDetails(args.error),
  };

  if (level === "error") {
    console.error("[Extra Usage Purchase]", logFields);
  } else if (level === "warn") {
    console.warn("[Extra Usage Purchase]", logFields);
  } else {
    console.info("[Extra Usage Purchase]", logFields);
  }
}
