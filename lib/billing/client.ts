import type {
  CancelSubscriptionInput,
  CancelSubscriptionResult,
  KeepSubscriptionResult,
  SubscriptionCancellationStatus,
} from "@/lib/billing/api-types";

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
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

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
