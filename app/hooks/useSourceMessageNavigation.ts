import { useEffect, useRef, useState } from "react";
import {
  getChatMessageElementId,
  getSourceMessageIdFromHash,
} from "@/lib/findings/source-message";
import { STICKY_BOTTOM_ESCAPE_EVENT } from "@/lib/utils/scroll-events";

type MessagePaginationStatus =
  "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

export function useSourceMessageNavigation({
  loadedMessageCount,
  paginationStatus,
  loadMore,
  revealMessage,
}: {
  loadedMessageCount: number;
  revealMessage?: (messageId: string) => boolean;
  paginationStatus?: MessagePaginationStatus;
  loadMore?: (numItems: number) => void;
}) {
  const [sourceMessageId, setSourceMessageId] = useState<string | null>(null);
  const scrolledMessageIdRef = useRef<string | null>(null);
  const requestedPageAtMessageCountRef = useRef<number | null>(null);

  useEffect(() => {
    const syncSourceMessage = () => {
      setSourceMessageId(getSourceMessageIdFromHash(window.location.hash));
    };

    syncSourceMessage();
    window.addEventListener("hashchange", syncSourceMessage);
    return () => window.removeEventListener("hashchange", syncSourceMessage);
  }, []);

  useEffect(() => {
    if (!sourceMessageId) {
      scrolledMessageIdRef.current = null;
      requestedPageAtMessageCountRef.current = null;
      return;
    }

    if (scrolledMessageIdRef.current === sourceMessageId) return;

    const target = document.getElementById(
      getChatMessageElementId(sourceMessageId),
    );
    if (target) {
      if (scrolledMessageIdRef.current === sourceMessageId) return;

      target.dispatchEvent(
        new CustomEvent(STICKY_BOTTOM_ESCAPE_EVENT, { bubbles: true }),
      );
      target.focus({ preventScroll: true });
      let scrollFrame: number | null = null;
      const layoutFrame = window.requestAnimationFrame(() => {
        scrollFrame = window.requestAnimationFrame(() => {
          if (!target.isConnected) return;
          scrolledMessageIdRef.current = sourceMessageId;
          target.scrollIntoView?.({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? "auto"
              : "smooth",
            block: "start",
          });
        });
      });

      return () => {
        window.cancelAnimationFrame(layoutFrame);
        if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
      };
    }

    if (revealMessage?.(sourceMessageId)) {
      let frame = 0;
      let attempts = 0;
      const focusRevealed = () => {
        const node = document.getElementById(
          getChatMessageElementId(sourceMessageId),
        );
        if (node) {
          node.focus({ preventScroll: true });
          scrolledMessageIdRef.current = sourceMessageId;
        } else if (++attempts < 60) {
          frame = window.requestAnimationFrame(focusRevealed);
        }
      };
      frame = window.requestAnimationFrame(focusRevealed);
      return () => window.cancelAnimationFrame(frame);
    }

    if (
      paginationStatus === "CanLoadMore" &&
      loadMore &&
      requestedPageAtMessageCountRef.current !== loadedMessageCount
    ) {
      requestedPageAtMessageCountRef.current = loadedMessageCount;
      loadMore(28);
    }
  }, [
    loadMore,
    loadedMessageCount,
    paginationStatus,
    sourceMessageId,
    revealMessage,
  ]);

  return sourceMessageId;
}
