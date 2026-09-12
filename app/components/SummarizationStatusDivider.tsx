"use client";

import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, NotebookText } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";

type SummarizationStatus = "started" | "completed" | string | undefined;

interface SummarizationStatusDividerProps {
  status?: SummarizationStatus;
  message?: string;
  startedAt?: number;
  className?: string;
}

const DEFAULT_STARTED_LABEL = "Preparing to continue…";
const DEFAULT_COMPLETED_LABEL = "Context automatically compacted";

const normalizeSummarizationLabel = (
  status: SummarizationStatus,
  message?: string,
) => {
  if (status === "started") {
    return !message ||
      message === "Summarizing chat context" ||
      message === "Compacting context" ||
      message === "Automatically compacting context"
      ? DEFAULT_STARTED_LABEL
      : message;
  }

  return !message || message === "Chat context summarized"
    ? DEFAULT_COMPLETED_LABEL
    : message;
};

export function SummarizationStatusDivider({
  status,
  message,
  startedAt,
  className,
}: SummarizationStatusDividerProps) {
  const isStarted = status === "started";
  const isFailed = status === "failed";
  const label = isFailed
    ? message ||
      "Couldn’t summarize earlier messages. Your existing context is unchanged."
    : normalizeSummarizationLabel(status, message);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!isStarted) return;
    const start =
      typeof startedAt === "number" && Number.isFinite(startedAt)
        ? startedAt
        : Date.now();
    const tick = () =>
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isStarted, startedAt]);

  return (
    <div
      className={cn(
        "not-prose flex w-full min-w-0 gap-2 text-sm leading-6 text-muted-foreground",
        isStarted ? "items-start" : "items-center",
        className,
      )}
      aria-live={isStarted || isFailed ? "polite" : undefined}
      data-testid="summarization-status"
    >
      {isStarted ? (
        <LoaderCircle
          className="mt-1 size-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : isFailed ? (
        <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <NotebookText
          className="size-4 shrink-0"
          aria-hidden="true"
          data-testid="summarization-status-icon"
        />
      )}
      {isStarted ? (
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Shimmer
              as="span"
              className="text-sm leading-6 motion-reduce:animate-none"
            >
              {label}
            </Shimmer>
            {elapsedSeconds >= 5 && (
              <span
                className="text-xs tabular-nums"
                aria-live="off"
                aria-label="Time spent preparing"
              >
                {elapsedSeconds}s
              </span>
            )}
          </div>
          {elapsedSeconds >= 5 && (
            <p className="text-xs leading-5">
              Summarizing earlier messages to make room. Your task will resume
              automatically.
            </p>
          )}
          {elapsedSeconds >= 30 && (
            <p className="text-xs leading-5">
              This is taking longer than usual. You can stop the task at any
              time.
            </p>
          )}
        </div>
      ) : (
        <span className="min-w-0 break-words">{label}</span>
      )}
    </div>
  );
}
