import { afterEach, describe, expect, it, jest } from "@jest/globals";

import {
  cancelSubscription,
  redirectToBillingPortal,
} from "@/lib/billing/client";

const originalFetch = globalThis.fetch;

function installFetchMock() {
  const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchMock,
  });

  return fetchMock;
}

describe("billing client", () => {
  afterEach(() => {
    if (originalFetch) {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }

    jest.restoreAllMocks();
  });

  it("turns aborted billing requests into a retryable timeout message", async () => {
    installFetchMock().mockRejectedValue(
      Object.assign(new Error("Request timed out"), {
        name: "TimeoutError",
      }) as never,
    );

    await expect(redirectToBillingPortal()).rejects.toThrow(
      "Billing request timed out. Please try again.",
    );
  });

  it("sends billing writes through no-store JSON requests", async () => {
    const input = {
      cancellationReason: {
        reasonCategory: "other",
        reasonDetails: "Testing the cancellation flow",
      },
    } as const;
    const fetchMock = installFetchMock().mockResolvedValue({
      ok: true,
      json: async () => ({
        canceled: true,
        cancelAtPeriodEnd: true,
        alreadyScheduled: false,
      }),
    } as Response);

    await cancelSubscription(input);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/billing/cancel",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify(input),
        headers: expect.objectContaining({
          "content-type": "application/json",
        }),
      }),
    );
  });
});
