import { useStickToBottom } from "use-stick-to-bottom";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { STICKY_BOTTOM_ESCAPE_EVENT } from "@/lib/utils/scroll-events";

export const CHAT_TIMELINE_ANCHOR_OFFSET = 16;
const TOUCH_SCROLL_INTENT_THRESHOLD_PX = 4;

export function getMessageScrollTarget({
  defaultTargetScrollTop,
  anchorMessageId,
  scrollElement,
  contentElement,
}: {
  defaultTargetScrollTop: number;
  anchorMessageId: string | null;
  scrollElement: HTMLElement;
  contentElement: HTMLElement;
}): number {
  if (!anchorMessageId) return defaultTargetScrollTop;

  const escapedAnchorMessageId =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(anchorMessageId)
      : anchorMessageId.replace(/["\\]/g, "\\$&");
  const anchorElement = contentElement.querySelector<HTMLElement>(
    `[data-timeline-message-id="${escapedAnchorMessageId}"]`,
  );
  const hasAnchoredEndSpace =
    scrollElement.dataset.timelineAnchoredEndSpace === "true";

  if (!anchorElement || !hasAnchoredEndSpace) {
    return defaultTargetScrollTop;
  }

  const scrollRect = scrollElement.getBoundingClientRect();
  const anchorRect = anchorElement.getBoundingClientRect();
  return Math.max(
    0,
    scrollElement.scrollTop +
      anchorRect.top -
      scrollRect.top -
      CHAT_TIMELINE_ANCHOR_OFFSET,
  );
}

export const useMessageScroll = (anchorMessageId: string | null = null) => {
  // use-stick-to-bottom retains the target callback created on mount, so the
  // callback must read the current turn rather than close over its first ID.
  const anchorMessageIdRef = useRef(anchorMessageId);
  useLayoutEffect(() => {
    anchorMessageIdRef.current = anchorMessageId;
  }, [anchorMessageId]);

  const stickToBottom = useStickToBottom({
    resize: "smooth",
    initial: "instant",
    targetScrollTop: (defaultTargetScrollTop, elements) =>
      getMessageScrollTarget({
        defaultTargetScrollTop,
        anchorMessageId: anchorMessageIdRef.current,
        ...elements,
      }),
  });
  const stickyScrollRef = stickToBottom.scrollRef;
  const stopStickyScroll = stickToBottom.stopScroll;

  const scrollToBottom = useCallback(
    (options?: {
      force?: boolean;
      instant?: boolean;
    }): boolean | Promise<boolean> => {
      if (options?.instant) {
        const scrollContainer = stickToBottom.scrollRef.current;
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
        return true;
      }

      return stickToBottom.scrollToBottom({
        animation: "smooth",
        preserveScrollPosition: !options?.force,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stickToBottom.scrollToBottom, stickToBottom.scrollRef],
  );

  useEffect(() => {
    const scrollContainer = stickyScrollRef.current;
    let touchStart:
      { clientX: number; clientY: number; scrollTop: number } | undefined;
    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;

      touchStart = {
        clientX: touch.clientX,
        clientY: touch.clientY,
        scrollTop: scrollContainer?.scrollTop ?? 0,
      };
    };
    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!scrollContainer || !touchStart || !touch) return;
      if (scrollContainer.scrollHeight <= scrollContainer.clientHeight) return;

      const horizontalDelta = Math.abs(touch.clientX - touchStart.clientX);
      const verticalDelta = touch.clientY - touchStart.clientY;
      const hasUpwardScrollIntent =
        verticalDelta > TOUCH_SCROLL_INTENT_THRESHOLD_PX &&
        verticalDelta > horizontalDelta;
      const hasMovedTowardHistory =
        scrollContainer.scrollTop < touchStart.scrollTop;

      if (hasUpwardScrollIntent || hasMovedTowardHistory) {
        // use-stick-to-bottom has an explicit wheel escape, but touch scrolling
        // can otherwise race its ResizeObserver animation on iOS. Escape as
        // soon as the gesture moves toward history so Safari owns the scroll.
        stopStickyScroll();
        touchStart = undefined;
      }
    };
    const clearTouchStart = () => {
      touchStart = undefined;
    };
    window.addEventListener(STICKY_BOTTOM_ESCAPE_EVENT, stopStickyScroll);

    scrollContainer?.addEventListener(
      STICKY_BOTTOM_ESCAPE_EVENT,
      stopStickyScroll,
    );
    scrollContainer?.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    scrollContainer?.addEventListener("touchmove", handleTouchMove, {
      passive: true,
    });
    scrollContainer?.addEventListener("touchend", clearTouchStart, {
      passive: true,
    });
    scrollContainer?.addEventListener("touchcancel", clearTouchStart, {
      passive: true,
    });

    return () => {
      window.removeEventListener(STICKY_BOTTOM_ESCAPE_EVENT, stopStickyScroll);
      scrollContainer?.removeEventListener(
        STICKY_BOTTOM_ESCAPE_EVENT,
        stopStickyScroll,
      );
      scrollContainer?.removeEventListener("touchstart", handleTouchStart);
      scrollContainer?.removeEventListener("touchmove", handleTouchMove);
      scrollContainer?.removeEventListener("touchend", clearTouchStart);
      scrollContainer?.removeEventListener("touchcancel", clearTouchStart);
    };
  }, [stickyScrollRef, stopStickyScroll]);

  return {
    scrollRef: stickToBottom.scrollRef,
    contentRef: stickToBottom.contentRef,
    isAtBottom: stickToBottom.isAtBottom,
    scrollToBottom,
  };
};
