type StripeWebhookLogArgs = {
  logPrefix: string;
  webhook: string;
  route: string;
  requestHeaders: Headers;
  body: string;
  signature: string | null;
};

type StripeWebhookSignatureFailureLogArgs = StripeWebhookLogArgs & {
  error: unknown;
};

type StripeWebhookLogFields = {
  timestamp: string;
  level: "warn";
  event:
    | "stripe_webhook_missing_signature"
    | "stripe_webhook_signature_verification_failed";
  service: "zhacker-web";
  environment: string;
  webhook: string;
  route: string;
  request_id?: string;
  payload_bytes: number;
  signature_header_present: boolean;
  signature_timestamp?: number;
  signature_has_v1: boolean;
  error_name?: string;
  error_type?: string;
  error_message?: string;
};

const MAX_ERROR_MESSAGE_LENGTH = 300;

function payloadBytes(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

function requestId(headers: Headers): string | undefined {
  return (
    headers.get("x-vercel-id") ??
    headers.get("x-request-id") ??
    headers.get("cf-ray") ??
    undefined
  );
}

function signatureSummary(signature: string | null): {
  signature_timestamp?: number;
  signature_has_v1: boolean;
} {
  if (!signature) {
    return { signature_has_v1: false };
  }

  let signatureTimestamp: number | undefined;
  let signatureHasV1 = false;

  for (const part of signature.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        signatureTimestamp = parsed;
      }
    } else if (key === "v1") {
      signatureHasV1 = true;
    }
  }

  return {
    signature_timestamp: signatureTimestamp,
    signature_has_v1: signatureHasV1,
  };
}

function errorString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const firstLine = value.split("\n", 1)[0]?.trim();
  if (!firstLine) return undefined;
  return firstLine.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function errorDetails(
  error: unknown,
): Pick<StripeWebhookLogFields, "error_name" | "error_type" | "error_message"> {
  if (!(error instanceof Error)) {
    return {
      error_message: errorString(String(error)),
    };
  }

  const errorWithType = error as Error & { type?: unknown };
  return {
    error_name: error.name || undefined,
    error_type:
      typeof errorWithType.type === "string" ? errorWithType.type : undefined,
    error_message: errorString(error.message),
  };
}

function baseFields(
  args: StripeWebhookLogArgs,
  event: StripeWebhookLogFields["event"],
): StripeWebhookLogFields {
  return {
    timestamp: new Date().toISOString(),
    level: "warn",
    event,
    service: "zhacker-web",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    webhook: args.webhook,
    route: args.route,
    request_id: requestId(args.requestHeaders),
    payload_bytes: payloadBytes(args.body),
    signature_header_present: Boolean(args.signature),
    ...signatureSummary(args.signature),
  };
}

export function logStripeWebhookMissingSignature(
  args: StripeWebhookLogArgs,
): void {
  console.warn(`${args.logPrefix} Missing stripe-signature header`, {
    ...baseFields(args, "stripe_webhook_missing_signature"),
  });
}

export function logStripeWebhookSignatureVerificationFailed(
  args: StripeWebhookSignatureFailureLogArgs,
): void {
  console.warn(`${args.logPrefix} Signature verification failed`, {
    ...baseFields(args, "stripe_webhook_signature_verification_failed"),
    ...errorDetails(args.error),
  });
}
