import { act, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockCaptureAuthenticatedEvent = jest.fn();
const mockNewCheckoutAttemptId = jest
  .fn<() => string>()
  .mockReturnValueOnce("ca_attempt_1")
  .mockReturnValueOnce("ca_attempt_2");
const mockToastError = jest.fn();
const originalFetch = globalThis.fetch;

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: "user_123" } }),
}));

jest.mock("sonner", () => ({
  toast: { error: mockToastError },
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: mockCaptureAuthenticatedEvent,
  getPostHogRequestHeaders: () => ({}),
  newCheckoutAttemptId: mockNewCheckoutAttemptId,
}));

const { useUpgrade } =
  require("../useUpgrade") as typeof import("../useUpgrade");

describe("useUpgrade", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNewCheckoutAttemptId
      .mockReset()
      .mockReturnValueOnce("ca_attempt_1")
      .mockReturnValueOnce("ca_attempt_2");
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  it("coalesces duplicate clicks and rerenders, then gives a retry a new ID", async () => {
    let resolveFirstRequest: ((response: Response) => void) | undefined;
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirstRequest = resolve;
    });
    const mockFetch = jest
      .fn<typeof fetch>()
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "retryable" }),
      } as Response);
    globalThis.fetch = mockFetch;

    const { result, rerender } = renderHook(() => useUpgrade());
    let firstUpgrade: Promise<void> | undefined;

    act(() => {
      firstUpgrade = result.current.handleUpgrade("pro-monthly-plan");
      void result.current.handleUpgrade("pro-monthly-plan");
    });
    rerender();
    await act(async () => {
      await result.current.handleUpgrade("pro-monthly-plan");
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    resolveFirstRequest?.({
      ok: false,
      status: 503,
      json: async () => ({ error: "temporary" }),
    } as Response);
    await act(async () => {
      await firstUpgrade;
    });

    await act(async () => {
      await result.current.handleUpgrade("pro-monthly-plan");
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const requestBodies = mockFetch.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(requestBodies.map((body) => body.checkoutAttemptId)).toEqual([
      "ca_attempt_1",
      "ca_attempt_2",
    ]);
    expect(
      requestBodies.every((body) =>
        Number.isFinite(Date.parse(body.checkoutAttemptStartedAt)),
      ),
    ).toBe(true);
  });
});
