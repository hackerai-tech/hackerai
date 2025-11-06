import { useStickToBottom } from "use-stick-to-bottom";
import { useCallback } from "react";

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

  return {
    scrollRef: stickToBottom.scrollRef,
    contentRef: stickToBottom.contentRef,
    isAtBottom: stickToBottom.isAtBottom,
    scrollToBottom,
  };
};
