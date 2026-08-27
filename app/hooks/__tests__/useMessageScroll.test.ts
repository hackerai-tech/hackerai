import { act, renderHook } from "@testing-library/react";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  getMessageScrollTarget,
  useMessageScroll,
} from "../useMessageScroll";

let mockCapturedTargetScrollTop:
  | ((
      targetScrollTop: number,
      elements: {
        scrollElement: HTMLElement;
        contentElement: HTMLElement;
      },
    ) => number)
  | undefined;
let mockScrollElement: HTMLElement | null = null;
const mockStopScroll = jest.fn();

jest.mock("use-stick-to-bottom", () => ({
  useStickToBottom: (options: {
    targetScrollTop?: typeof mockCapturedTargetScrollTop;
  }) => {
    mockCapturedTargetScrollTop ??= options.targetScrollTop;
    return {
      scrollRef: { current: mockScrollElement },
      contentRef: { current: null },
      isAtBottom: true,
      scrollToBottom: jest.fn(),
      stopScroll: mockStopScroll,
    };
  },
}));

const dispatchTouch = (
  element: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  point?: { clientX: number; clientY: number },
) => {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", {
    value: point ? [point] : [],
  });
  element.dispatchEvent(event);
};

const rect = (top: number, height: number): DOMRect =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

describe("getMessageScrollTarget", () => {
  beforeEach(() => {
    mockCapturedTargetScrollTop = undefined;
    mockScrollElement = null;
    mockStopScroll.mockReset();
  });

  it("keeps the active user row at the configured top offset", () => {
    const scrollElement = document.createElement("div");
    const contentElement = document.createElement("div");
    const anchorElement = document.createElement("div");

    anchorElement.dataset.timelineMessageId = "user-2";
    scrollElement.dataset.timelineAnchoredEndSpace = "true";
    contentElement.append(anchorElement);
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      value: 200,
    });
    scrollElement.getBoundingClientRect = () => rect(50, 700);
    anchorElement.getBoundingClientRect = () => rect(100, 80);

    expect(
      getMessageScrollTarget({
        defaultTargetScrollTop: 600,
        anchorMessageId: "user-2",
        scrollElement,
        contentElement,
      }),
    ).toBe(200 + 100 - 50 - CHAT_TIMELINE_ANCHOR_OFFSET);
  });

  it("follows the real end after the reserved trailing space is gone", () => {
    const scrollElement = document.createElement("div");
    const contentElement = document.createElement("div");
    const anchorElement = document.createElement("div");

    anchorElement.dataset.timelineMessageId = "user-2";
    scrollElement.dataset.timelineAnchoredEndSpace = "false";
    contentElement.append(anchorElement);

    expect(
      getMessageScrollTarget({
        defaultTargetScrollTop: 600,
        anchorMessageId: "user-2",
        scrollElement,
        contentElement,
      }),
    ).toBe(600);
  });

  it("uses the latest anchor through the callback captured on mount", () => {
    const { rerender } = renderHook(
      ({ anchorMessageId }) => useMessageScroll(anchorMessageId),
      { initialProps: { anchorMessageId: "user-1" } },
    );
    rerender({ anchorMessageId: "user-2" });

    const scrollElement = document.createElement("div");
    const contentElement = document.createElement("div");
    const anchorElement = document.createElement("div");

    anchorElement.dataset.timelineMessageId = "user-2";
    scrollElement.dataset.timelineAnchoredEndSpace = "true";
    contentElement.append(anchorElement);
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      value: 200,
    });
    scrollElement.getBoundingClientRect = () => rect(50, 700);
    anchorElement.getBoundingClientRect = () => rect(100, 80);

    expect(
      mockCapturedTargetScrollTop?.(600, {
        scrollElement,
        contentElement,
      }),
    ).toBe(200 + 100 - 50 - CHAT_TIMELINE_ANCHOR_OFFSET);
  });
});

describe("useMessageScroll touch navigation", () => {
  beforeEach(() => {
    mockScrollElement = document.createElement("div");
    mockStopScroll.mockReset();
    Object.defineProperties(mockScrollElement, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: { configurable: true, writable: true, value: 1_200 },
    });
  });

  it("escapes sticky follow when a touch gesture moves toward history", () => {
    const { unmount } = renderHook(() => useMessageScroll("user-2"));
    const scrollElement = mockScrollElement!;

    act(() => {
      dispatchTouch(scrollElement, "touchstart", {
        clientX: 100,
        clientY: 300,
      });
      dispatchTouch(scrollElement, "touchmove", {
        clientX: 101,
        clientY: 312,
      });
    });

    expect(mockStopScroll).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("keeps sticky follow for taps and horizontal touch movement", () => {
    const { unmount } = renderHook(() => useMessageScroll("user-2"));
    const scrollElement = mockScrollElement!;

    act(() => {
      dispatchTouch(scrollElement, "touchstart", {
        clientX: 100,
        clientY: 300,
      });
      dispatchTouch(scrollElement, "touchmove", {
        clientX: 120,
        clientY: 302,
      });
      dispatchTouch(scrollElement, "touchend");
    });

    expect(mockStopScroll).not.toHaveBeenCalled();
    unmount();
  });

  it("does not escape when the transcript cannot scroll", () => {
    Object.defineProperty(mockScrollElement, "scrollHeight", {
      configurable: true,
      value: 600,
    });
    const { unmount } = renderHook(() => useMessageScroll("user-2"));
    const scrollElement = mockScrollElement!;

    act(() => {
      dispatchTouch(scrollElement, "touchstart", {
        clientX: 100,
        clientY: 300,
      });
      dispatchTouch(scrollElement, "touchmove", {
        clientX: 100,
        clientY: 320,
      });
    });

    expect(mockStopScroll).not.toHaveBeenCalled();
    unmount();
  });
});
