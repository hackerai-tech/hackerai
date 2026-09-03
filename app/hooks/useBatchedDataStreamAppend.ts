"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ScopedDataUIPart } from "@/app/components/DataStreamProvider";

/**
 * Data parts that arrive within this window are appended in one state update.
 * Terminal output alone can emit dozens of parts a second, and every append
 * used to copy the whole array and re-run every consumer effect.
 */
export const DATA_STREAM_BATCH_WINDOW_MS = 100;

type SetDataStream = React.Dispatch<React.SetStateAction<ScopedDataUIPart[]>>;

/**
 * Throttle-first batching for `dataStream` appends: the first part opens a
 * window, later parts are absorbed into it, and one `setDataStream` runs when
 * the window closes. Nothing is dropped and order is preserved. `clear`
 * discards pending parts as well so a stale chat cannot resurrect after reset.
 */
export function useBatchedDataStreamAppend(
  setDataStream: SetDataStream,
  windowMs: number = DATA_STREAM_BATCH_WINDOW_MS,
) {
  const pendingRef = useRef<ScopedDataUIPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const flushDataStream = useCallback(() => {
    cancelTimer();
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    setDataStream((current) => current.concat(pending));
  }, [setDataStream]);

  const appendDataPart = useCallback(
    (part: ScopedDataUIPart) => {
      pendingRef.current.push(part);
      if (timerRef.current === null) {
        timerRef.current = setTimeout(flushDataStream, windowMs);
      }
    },
    [flushDataStream, windowMs],
  );

  const clearDataStream = useCallback(() => {
    cancelTimer();
    pendingRef.current = [];
    setDataStream([]);
  }, [setDataStream]);

  useEffect(() => cancelTimer, []);

  return { appendDataPart, flushDataStream, clearDataStream };
}
