import { useEffect, useRef, useState } from "react";
import {
  getChatMessageElementId,
  getSourceMessageIdFromHash,
} from "@/lib/findings/source-message";

type MessagePaginationStatus =
  "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

export function useSourceMessageNavigation({
  messageIds,
  paginationStatus,
  loadMore,
}: {
  messageIds: string[];
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

    const target = document.getElementById(
      getChatMessageElementId(sourceMessageId),
    );
    if (target) {
      if (scrolledMessageIdRef.current === sourceMessageId) return;

      scrolledMessageIdRef.current = sourceMessageId;
      target.scrollIntoView?.({ behavior: "smooth", block: "start" });
      target.focus({ preventScroll: true });
      return;
    }

    if (
      paginationStatus === "CanLoadMore" &&
      loadMore &&
      requestedPageAtMessageCountRef.current !== messageIds.length
    ) {
      requestedPageAtMessageCountRef.current = messageIds.length;
      loadMore(28);
    }
  }, [loadMore, messageIds, paginationStatus, sourceMessageId]);

  return sourceMessageId;
}
