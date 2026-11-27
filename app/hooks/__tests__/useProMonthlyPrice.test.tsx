import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

import {
  useProMonthlyPrice,
  useProMonthlyPriceExposure,
} from "../useProMonthlyPrice";

let mockAuth: {
  user: { id: string } | null;
  organizationId?: string;
  loading?: boolean;
} = { user: { id: "user-1" } };
const mockCapture = jest.fn();

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => mockAuth,
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
}));

const controlQuote = {
  priceLookupKey: "pro-monthly-plan",
  displayedAmountDollars: 29,
  currency: "usd",
  billingInterval: "month",
  stripePriceId: "price_pro_29",
};
const assignment = {
  version: 1,
  key: "hac248-pro-monthly-49-pricing-proposal",
  variant: "test",
  priceLookupKey: "pro-monthly-plan-49-hac248",
  displayedAmountDollars: 49,
  stripePriceId: "price_pro_49",
  assignedAt: "2026-11-20T10:00:00.000Z",
};
const assignedQuote = {
  ...controlQuote,
  priceLookupKey: "pro-monthly-plan-49-hac248",
  displayedAmountDollars: 49,
  stripePriceId: "price_pro_49",
  assignment,
};
const ok = (body: unknown) => ({ ok: true, json: async () => body });

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
);

describe("useProMonthlyPrice", () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth = { user: { id: "user-1" } };
    mockCapture.mockReturnValue(true);
    global.fetch = mockFetch;
  });

  it("does not resolve a price for a signed-out visitor or a hidden surface", () => {
    mockAuth = { user: null };
    const signedOut = renderHook(() => useProMonthlyPrice(true), { wrapper });
    expect(signedOut.result.current.status).toBe("signed-out");

    mockAuth = { user: { id: "user-1" }, loading: true };
    const authResolving = renderHook(() => useProMonthlyPrice(true), {
      wrapper,
    });
    expect(authResolving.result.current.status).toBe("signed-out");

    mockAuth = { user: { id: "user-1" } };
    const hidden = renderHook(() => useProMonthlyPrice(false), { wrapper });
    expect(hidden.result.current.status).toBe("idle");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("recovers from a failed request through retry", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const { result } = renderHook(() => useProMonthlyPrice(true), { wrapper });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("error"));

    mockFetch.mockResolvedValueOnce(ok(assignedQuote));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({
      quote: { price: { displayedAmountDollars: 49 }, assignment },
    });
  });

  it("never shows a previous account's price after the account changes", async () => {
    mockFetch.mockResolvedValueOnce(ok(assignedQuote));
    const { result, rerender } = renderHook(() => useProMonthlyPrice(true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let resolveNext!: (value: unknown) => void;
    mockFetch.mockImplementationOnce(
      () => new Promise((resolve) => (resolveNext = resolve)),
    );
    mockAuth = { user: { id: "user-2" } };
    rerender();
    expect(result.current.status).toBe("loading");

    await act(async () => resolveNext(ok(controlQuote)));
    await waitFor(() =>
      expect(result.current).toMatchObject({
        status: "ready",
        quote: { price: { displayedAmountDollars: 29 } },
      }),
    );
  });

  it("treats an inconsistent price as an error, not a definite price", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({ ...controlQuote, displayedAmountDollars: 19 }),
    );
    const { result } = renderHook(() => useProMonthlyPrice(true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("error"));
  });
});

describe("useProMonthlyPriceExposure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCapture.mockReturnValue(true);
  });

  it("records exposure only once an assigned quote is visible", () => {
    const quote = {
      price: assignedQuote,
      assignment: { ...assignment, assignedAt: "2026-11-21T10:00:00.000Z" },
    } as never;
    const { rerender } = renderHook(
      ({ visible }) =>
        useProMonthlyPriceExposure(quote, "pricing_dialog", visible),
      { initialProps: { visible: false } },
    );
    expect(mockCapture).not.toHaveBeenCalled();

    rerender({ visible: true });
    rerender({ visible: true });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      "hac248_pro_monthly_pricing_exposed",
      expect.objectContaining({
        experiment_variant: "test",
        exposure_surface: "pricing_dialog",
      }),
    );
  });

  it("does not record exposure for an unassigned account", () => {
    renderHook(() =>
      useProMonthlyPriceExposure(
        { price: controlQuote } as never,
        "pricing_dialog",
        true,
      ),
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
