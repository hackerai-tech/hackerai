import { useStickToBottom } from "use-stick-to-bottom";
import { useCallback } from "react";

export const useMessageScroll = () => {
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } = useStickToBottom();

  const handleScrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [scrollRef]);

  return {
    scrollRef,
    contentRef,
    scrollToBottom: handleScrollToBottom,
    isAtBottom,
  };
};