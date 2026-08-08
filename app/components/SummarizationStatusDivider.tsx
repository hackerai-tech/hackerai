"use client";

import { NotebookText } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";

type SummarizationStatus = "started" | "completed" | string | undefined;

interface SummarizationStatusDividerProps {
  status?: SummarizationStatus;
  message?: string;
  className?: string;
}

const DEFAULT_STARTED_LABEL = "Automatically compacting context";
const DEFAULT_COMPLETED_LABEL = "Context automatically compacted";

const normalizeSummarizationLabel = (
  status: SummarizationStatus,
  message?: string,
) => {
  if (status === "started") {
    return !message ||
      message === "Summarizing chat context" ||
      message === "Compacting context"
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
  className,
}: SummarizationStatusDividerProps) {
  const isStarted = status === "started";
  const label = normalizeSummarizationLabel(status, message);

  return (
    <div
      className={cn(
        "not-prose my-4 flex w-full min-w-0 items-center gap-2 text-sm leading-6 text-muted-foreground",
        className,
      )}
      aria-live={isStarted ? "polite" : undefined}
      data-testid="summarization-status"
    >
      {!isStarted && (
        <NotebookText
          className="size-4 shrink-0"
          aria-hidden="true"
          data-testid="summarization-status-icon"
        />
      )}
      {isStarted ? (
        <Shimmer as="span" className="min-w-0 truncate text-sm leading-6">
          {label}
        </Shimmer>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
    </div>
  );
}
