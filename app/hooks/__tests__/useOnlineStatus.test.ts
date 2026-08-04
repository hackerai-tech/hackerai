import { act, renderHook } from "@testing-library/react";
import { useOnlineStatus } from "../useOnlineStatus";

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

  afterEach(() => {
    if (originalOnlineDescriptor) {
      Object.defineProperty(navigator, "onLine", originalOnlineDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "onLine");
    }
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
});
