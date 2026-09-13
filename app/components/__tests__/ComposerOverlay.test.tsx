import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ComposerOverlay } from "../ComposerOverlay";

describe("ComposerOverlay", () => {
  it("tracks dynamic composer height while keeping it out of document flow", async () => {
    let measuredHeight = 112;
    let resizeCallback: ResizeObserverCallback | null = null;
    const onHeightChange = jest.fn();
    const originalResizeObserverDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ResizeObserver",
    );
    const getBoundingClientRectSpy = jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({
        bottom: measuredHeight,
        height: measuredHeight,
        left: 0,
        right: 768,
        top: 0,
        width: 768,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }));

    class ResizeObserverMock implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      disconnect = jest.fn();
      observe = jest.fn();
      unobserve = jest.fn();
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });

    try {
      const { rerender } = render(
        <ComposerOverlay active onHeightChange={onHeightChange}>
          <div>Composer</div>
        </ComposerOverlay>,
      );

      const overlay = screen.getByText("Composer").parentElement;
      expect(overlay).toHaveClass("absolute", "bottom-0");
      await waitFor(() => expect(onHeightChange).toHaveBeenCalledWith(112));

      measuredHeight = 168;
      act(() => {
        (resizeCallback as ResizeObserverCallback)([], {} as ResizeObserver);
      });
      expect(onHeightChange).toHaveBeenLastCalledWith(168);

      rerender(
        <ComposerOverlay active={false} onHeightChange={onHeightChange}>
          <div>Composer</div>
        </ComposerOverlay>,
      );

      expect(screen.getByText("Composer").parentElement).toHaveClass(
        "flex-shrink-0",
      );
      expect(onHeightChange).toHaveBeenLastCalledWith(0);
    } finally {
      getBoundingClientRectSpy.mockRestore();
      if (originalResizeObserverDescriptor) {
        Object.defineProperty(
          globalThis,
          "ResizeObserver",
          originalResizeObserverDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });
});
