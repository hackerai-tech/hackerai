import { renderHook } from "@testing-library/react";
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

jest.mock("use-stick-to-bottom", () => ({
  useStickToBottom: (options: {
    targetScrollTop?: typeof mockCapturedTargetScrollTop;
  }) => {
    mockCapturedTargetScrollTop ??= options.targetScrollTop;
    return {
      scrollRef: { current: null },
      contentRef: { current: null },
      isAtBottom: true,
      scrollToBottom: jest.fn(),
      stopScroll: jest.fn(),
    };
  },
}));

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
