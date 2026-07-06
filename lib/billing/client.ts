import type {
  CancelSubscriptionInput,
  CancelSubscriptionResult,
  KeepSubscriptionResult,
  SubscriptionCancellationStatus,
} from "@/lib/billing/api-types";

const BILLING_REQUEST_TIMEOUT_MS = 15_000;
const BILLING_REQUEST_TIMEOUT_MESSAGE =
  "Billing request timed out. Please try again.";

function billingRequestSignal(
  signal: RequestInit["signal"],
): RequestInit["signal"] {
  if (signal) return signal;
  if (typeof AbortSignal === "undefined") return undefined;

  const timeout = (
    AbortSignal as typeof AbortSignal & {
      timeout?: (milliseconds: number) => AbortSignal;
    }
  ).timeout;

  return timeout?.(BILLING_REQUEST_TIMEOUT_MS);
}

function isAbortLikeError(error: unknown) {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";

  return name === "AbortError" || name === "TimeoutError";
}

async function readBillingError(response: Response): Promise<string> {
  const fallback = `Billing request failed (${response.status})`;

  try {
    const body = (await response.json()) as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof body.error === "string" && body.error) return body.error;
    if (typeof body.message === "string" && body.message) return body.message;
  } catch {}

  return fallback;
}

async function billingFetchJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      signal: billingRequestSignal(init.signal),
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new Error(BILLING_REQUEST_TIMEOUT_MESSAGE);
    }

    throw error;
  }

  if (!response.ok) {
    throw new Error(await readBillingError(response));
  }

  return (await response.json()) as T;
}

export async function getSubscriptionCancellationStatus(): Promise<SubscriptionCancellationStatus> {
  return billingFetchJson<SubscriptionCancellationStatus>(
    "/api/billing/subscription-status",
  );
}

export async function redirectToBillingPortal(): Promise<string> {
  const { url } = await billingFetchJson<{ url?: unknown }>(
    "/api/billing/portal",
    { method: "POST" },
  );

  if (typeof url !== "string" || !url) {
    throw new Error("Failed to open billing portal");
  }

  return url;
}

export async function keepSubscription(): Promise<KeepSubscriptionResult> {
  return billingFetchJson<KeepSubscriptionResult>("/api/billing/keep", {
    method: "POST",
  });
}

export async function cancelSubscription(
  input: CancelSubscriptionInput,
): Promise<CancelSubscriptionResult> {
  return billingFetchJson<CancelSubscriptionResult>("/api/billing/cancel", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
