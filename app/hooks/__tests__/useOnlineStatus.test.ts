import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, jest } from "@jest/globals";
import { reconnectOnlineStatus, useOnlineStatus } from "../useOnlineStatus";

const setNavigatorOnline = (isOnline: boolean) => {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: isOnline,
  });
};

describe("useOnlineStatus", () => {
  const originalOnlineDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "onLine",
  );
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    if (originalOnlineDescriptor) {
      Object.defineProperty(navigator, "onLine", originalOnlineDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "onLine");
    }
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  });

  it("tracks browser offline and online events", () => {
    setNavigatorOnline(true);
    const { result } = renderHook(() => useOnlineStatus());

    expect(result.current).toBe(true);

    act(() => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);

    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(true);
  });

  it("marks the browser online after the reconnect probe succeeds", async () => {
    setNavigatorOnline(false);
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useOnlineStatus());

    let reconnected = false;
    await act(async () => {
      reconnected = await reconnectOnlineStatus();
    });

    expect(reconnected).toBe(true);
    expect(result.current).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/health/connectivity", {
      method: "HEAD",
      cache: "no-store",
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    });
  });

  it("stays offline when the reconnect probe fails", async () => {
    setNavigatorOnline(false);
    (globalThis.fetch as jest.Mock).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const { result } = renderHook(() => useOnlineStatus());

    let reconnected = true;
    await act(async () => {
      reconnected = await reconnectOnlineStatus();
    });

    expect(reconnected).toBe(false);
    expect(result.current).toBe(false);
  });

  it("times out a hung probe and allows a later reconnect", async () => {
    jest.useFakeTimers();
    setNavigatorOnline(false);
    (globalThis.fetch as jest.Mock).mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const { result } = renderHook(() => useOnlineStatus());

    let timedOutReconnect: Promise<boolean>;
    act(() => {
      timedOutReconnect = reconnectOnlineStatus();
    });
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      expect(await timedOutReconnect).toBe(false);
    });

    expect(result.current).toBe(false);
    expect(
      (globalThis.fetch as jest.Mock).mock.calls[0]?.[1]?.signal.aborted,
    ).toBe(true);

    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });
    await act(async () => {
      await expect(reconnectOnlineStatus()).resolves.toBe(true);
    });

    expect(result.current).toBe(true);
  });
});
