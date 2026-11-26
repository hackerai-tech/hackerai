import { useEffect, useRef } from "react";
import type { ChatStatus } from "@/types";

/** Attempts per continued run: the first attach, then retries after errors. */
export const AUTO_CONTINUE_ATTACH_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;

/**
 * Attaches this page to a run the server continued after its computer came
 * back (HAC-275), as a reload would. The chat may be `ready` or still show the
 * stream that the outage broke as `error`. A failed attach leaves the chat in
 * `error` and retries a few times with backoff; after a successful attach,
 * the run is never attached again.
 */
export function useAttachAutoContinuedRun({
  continuedRunId,
  activeTriggerRunId,
  attachedRunId,
  status,
  resumeStream,
}: {
  continuedRunId: string | undefined;
  activeTriggerRunId: string | null | undefined;
  /** A run this page already streams. */
  attachedRunId: string | null;
  status: ChatStatus;
  resumeStream: () => Promise<void>;
}) {
  const attempts = useRef<{ runId: string; count: number } | null>(null);
  useEffect(() => {
    if (
      !continuedRunId ||
      continuedRunId !== activeTriggerRunId ||
      attachedRunId ||
      (status !== "ready" && status !== "error")
    )
      return;
    const made =
      attempts.current?.runId === continuedRunId ? attempts.current.count : 0;
    // After an attempt, `ready` means it attached and the stream ended.
    if (
      made >= AUTO_CONTINUE_ATTACH_ATTEMPTS ||
      (made > 0 && status !== "error")
    )
      return;
    const timer = setTimeout(
      () => {
        attempts.current = { runId: continuedRunId, count: made + 1 };
        void resumeStream();
      },
      made === 0 ? 0 : RETRY_BASE_MS * 2 ** (made - 1),
    );
    return () => clearTimeout(timer);
  }, [activeTriggerRunId, attachedRunId, continuedRunId, resumeStream, status]);
}
