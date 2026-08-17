import { act, renderHook } from "@testing-library/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { toast } from "sonner";
import { useUpgrade } from "../useUpgrade";
import {
  captureAuthenticatedEvent,
  getPostHogRequestHeaders,
  newCheckoutAttemptId,
} from "@/lib/analytics/client";

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: jest.fn(),
  getPostHogRequestHeaders: jest.fn(() => ({})),
  newCheckoutAttemptId: jest.fn(),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockNewCheckoutAttemptId = newCheckoutAttemptId as jest.MockedFunction<
  typeof newCheckoutAttemptId
>;
const mockCaptureAuthenticatedEvent =
  captureAuthenticatedEvent as jest.MockedFunction<
    typeof captureAuthenticatedEvent
  >;
const mockGetPostHogRequestHeaders =
  getPostHogRequestHeaders as jest.MockedFunction<
    typeof getPostHogRequestHeaders
  >;
const mockToastError = toast.error as jest.MockedFunction<typeof toast.error>;
const mockToastInfo = toast.info as jest.MockedFunction<typeof toast.info>;

function response({
  ok,
  status,
  body,
}: {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("useUpgrade checkout attempts", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({
      user: { id: "user_123" },
    } as ReturnType<typeof useAuth>);
    mockGetPostHogRequestHeaders.mockReturnValue({});
    mockCaptureAuthenticatedEvent.mockReturnValue(true);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
  });

  it("coalesces duplicate clicks before React commits the loading state", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    global.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    mockNewCheckoutAttemptId.mockReturnValue("ca_click_123");
    const { result } = renderHook(() => useUpgrade());

    let firstRequest!: Promise<void>;
    let duplicateRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.handleUpgrade("pro-monthly-plan");
      duplicateRequest = result.current.handleUpgrade("pro-monthly-plan");
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockNewCheckoutAttemptId).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.(
        response({ ok: true, status: 200, body: { error: "cancelled" } }),
      );
      await Promise.all([firstRequest, duplicateRequest]);
    });
  });

  it("keeps the synchronous submit lock across re-renders", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    global.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    mockNewCheckoutAttemptId.mockReturnValue("ca_render_123");
    const { result, rerender } = renderHook(() => useUpgrade());

    let firstRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.handleUpgrade("pro-monthly-plan");
    });
    rerender();

    await act(async () => {
      await result.current.handleUpgrade("pro-monthly-plan");
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockNewCheckoutAttemptId).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.(
        response({ ok: true, status: 200, body: { error: "cancelled" } }),
      );
      await firstRequest;
    });
  });

  it("blocks duplicate sidebar checkout across pricing dialog remounts", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    global.fetch = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      )
      .mockResolvedValueOnce(
        response({ ok: true, status: 200, body: { error: "cancelled" } }),
      );
    mockNewCheckoutAttemptId
      .mockReturnValueOnce("ca_sidebar_123")
      .mockReturnValueOnce("ca_sidebar_retry_456");
    const firstDialog = renderHook(() => useUpgrade());

    let firstRequest!: Promise<void>;
    act(() => {
      firstRequest = firstDialog.result.current.handleUpgrade(
        "pro-monthly-plan",
        undefined,
        undefined,
        "free",
        { source: "sidebar", surface: "pricing_dialog" },
      );
    });
    firstDialog.unmount();

    const remountedDialog = renderHook(() => useUpgrade());
    await act(async () => {
      await remountedDialog.result.current.handleUpgrade(
        "pro-monthly-plan",
        undefined,
        undefined,
        "free",
        { source: "sidebar", surface: "pricing_dialog" },
      );
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockNewCheckoutAttemptId).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.(
        response({
          ok: false,
          status: 503,
          body: { error: "Checkout temporarily unavailable" },
        }),
      );
      await firstRequest;
    });

    await act(async () => {
      await remountedDialog.result.current.handleUpgrade(
        "pro-monthly-plan",
        undefined,
        undefined,
        "free",
        { source: "sidebar", surface: "pricing_dialog" },
      );
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockNewCheckoutAttemptId).toHaveBeenCalledTimes(2);
    const requestBodies = (global.fetch as jest.Mock).mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)),
    );
    expect(requestBodies.map((body) => body.checkoutAttemptId)).toEqual([
      "ca_sidebar_123",
      "ca_sidebar_retry_456",
    ]);
  });

  it("creates a distinct attempt ID for a valid retry after failure", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          ok: false,
          status: 503,
          body: { error: "Checkout temporarily unavailable" },
        }),
      )
      .mockResolvedValueOnce(
        response({ ok: true, status: 200, body: { error: "cancelled" } }),
      );
    mockNewCheckoutAttemptId
      .mockReturnValueOnce("ca_first_123")
      .mockReturnValueOnce("ca_retry_456");
    const { result } = renderHook(() => useUpgrade());

    await act(async () => {
      await result.current.handleUpgrade("pro-monthly-plan");
    });
    await act(async () => {
      await result.current.handleUpgrade("pro-monthly-plan");
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const requestBodies = (global.fetch as jest.Mock).mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)),
    );
    expect(requestBodies.map((body) => body.checkoutAttemptId)).toEqual([
      "ca_first_123",
      "ca_retry_456",
    ]);
    expect(mockToastError).toHaveBeenCalledWith(
      "Checkout temporarily unavailable",
    );
  });

  it("allows an immediate retry when checkout navigation fails", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 200,
          body: { url: "https://[" },
        }),
      )
      .mockResolvedValueOnce(
        response({ ok: true, status: 200, body: { error: "cancelled" } }),
      );
    mockNewCheckoutAttemptId
      .mockReturnValueOnce("ca_redirect_failed_123")
      .mockReturnValueOnce("ca_redirect_retry_456");
    const { result } = renderHook(() => useUpgrade());

    await act(async () => {
      await result.current.handleUpgrade("pro-monthly-plan");
    });
    await act(async () => {
      await result.current.handleUpgrade("pro-monthly-plan");
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(
      window.sessionStorage.getItem("hackerai:billing:checkout-navigation:v1"),
    ).toBeNull();
  });

  it("suppresses a recent checkout redirect after a page reload", async () => {
    window.sessionStorage.setItem(
      "hackerai:billing:checkout-navigation:v1",
      JSON.stringify({
        attemptId: "ca_recent_redirect_123",
        plan: "pro-monthly-plan",
        startedAt: Date.now(),
      }),
    );
    global.fetch = jest.fn();
    const { result } = renderHook(() => useUpgrade());

    await act(async () => {
      await result.current.handleUpgrade(
        "pro-monthly-plan",
        undefined,
        undefined,
        "free",
        { source: "sidebar", surface: "pricing_dialog" },
      );
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockNewCheckoutAttemptId).not.toHaveBeenCalled();
    expect(mockToastInfo).toHaveBeenCalledWith("Checkout is already opening", {
      description: "Wait a moment before trying again.",
    });
    expect(mockCaptureAuthenticatedEvent).toHaveBeenCalledWith(
      "checkout_redirect_suppressed",
      expect.objectContaining({
        checkout_attempt_id: "ca_recent_redirect_123",
        plan: "pro-monthly-plan",
        source: "sidebar",
        suppression_reason: "recent_navigation",
        guard_window_ms: 30_000,
      }),
    );
  });

  it("keeps the submit lock held once checkout navigation starts", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response({
        ok: true,
        status: 200,
        body: { url: `${window.location.origin}/#checkout` },
      }),
    );
    mockNewCheckoutAttemptId.mockReturnValue("ca_redirect_123");
    const { result } = renderHook(() => useUpgrade());

    await act(async () => {
      await result.current.handleUpgrade("pro-monthly-plan");
    });
    await act(async () => {
      await result.current.handleUpgrade("pro-monthly-plan");
    });

    expect(window.location.hash).toBe("#checkout");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockNewCheckoutAttemptId).toHaveBeenCalledTimes(1);
    expect(result.current.upgradeLoading).toBe(true);
  });
});
