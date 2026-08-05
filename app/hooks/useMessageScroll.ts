import { useStickToBottom } from "use-stick-to-bottom";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { STICKY_BOTTOM_ESCAPE_EVENT } from "@/lib/utils/scroll-events";

export const CHAT_TIMELINE_ANCHOR_OFFSET = 16;

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
    const scrollContainer = stickToBottom.scrollRef.current;
    window.addEventListener(
      STICKY_BOTTOM_ESCAPE_EVENT,
      stickToBottom.stopScroll,
    );

    scrollContainer?.addEventListener(
      STICKY_BOTTOM_ESCAPE_EVENT,
      stickToBottom.stopScroll,
    );

    return () => {
      window.removeEventListener(
        STICKY_BOTTOM_ESCAPE_EVENT,
        stickToBottom.stopScroll,
      );
      scrollContainer?.removeEventListener(
        STICKY_BOTTOM_ESCAPE_EVENT,
        stickToBottom.stopScroll,
      );
    };
  }, [stickToBottom.scrollRef, stickToBottom.stopScroll]);

  return {
    scrollRef: stickToBottom.scrollRef,
    contentRef: stickToBottom.contentRef,
    isAtBottom: stickToBottom.isAtBottom,
    scrollToBottom,
  };
};
