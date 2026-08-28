import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { useMediaQuery } from "../use-media-query";

describe("useMediaQuery", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("updates when the media query result changes", () => {
    let matches = false;
    const listeners = new Set<() => void>();
    const mediaQueryList = {
      get matches() {
        return matches;
      },
      media: "(max-width: 949px)",
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    } as MediaQueryList;
    window.matchMedia = jest.fn(() => mediaQueryList);

    const { result } = renderHook(() => useMediaQuery(mediaQueryList.media));
    expect(result.current).toBe(false);

    act(() => {
      matches = true;
      listeners.forEach((listener) => listener());
    });

    expect(result.current).toBe(true);
  });
});
