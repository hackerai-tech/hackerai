import { useStickToBottom } from "use-stick-to-bottom";
import { useCallback, useEffect } from "react";
import { STICKY_BOTTOM_ESCAPE_EVENT } from "@/lib/utils/scroll-events";

export const useMessageScroll = () => {
  const stickToBottom = useStickToBottom({
    resize: "smooth",
    initial: "instant",
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
