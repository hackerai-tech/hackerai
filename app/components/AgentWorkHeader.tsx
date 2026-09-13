"use client";

import { memo, useEffect, useState } from "react";
import type {
  KeyboardEventHandler,
  MouseEventHandler,
  PointerEventHandler,
  TouchEventHandler,
} from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { formatDuration } from "@/components/ai-elements/worked-for";

type AgentWorkHeaderProps = {
  canToggle: boolean;
  durationMs?: number;
  expanded: boolean;
  isTiming: boolean;
  messageId: string;
  onCaptureScroll: (target: EventTarget | null) => void;
  onToggle: (messageId: string, nextExpanded: boolean) => void;
  startedAt?: number;
};

export const AgentWorkHeader = memo(function AgentWorkHeader({
  canToggle,
  durationMs,
  expanded,
  isTiming,
  messageId,
  onCaptureScroll,
  onToggle,
  startedAt,
}: AgentWorkHeaderProps) {
  const [elapsedMs, setElapsedMs] = useState(() =>
    typeof startedAt === "number" ? Math.max(0, Date.now() - startedAt) : 0,
  );

  useEffect(() => {
    if (!isTiming) return;

    const effectiveStartedAt =
      typeof startedAt === "number" && Number.isFinite(startedAt)
        ? startedAt
        : Date.now();
    const updateElapsed = () => {
      setElapsedMs(Math.max(0, Date.now() - effectiveStartedAt));
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(intervalId);
  }, [isTiming, startedAt]);

  const label = isTiming
    ? `Working for ${formatDuration(elapsedMs)}`
    : typeof durationMs === "number" && durationMs > 0
      ? `Worked for ${formatDuration(durationMs)}`
      : "Worked";
  const handlePointerDown: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (canToggle && !event.defaultPrevented) {
      onCaptureScroll(event.currentTarget);
    }
  };
  const handleTouchStart: TouchEventHandler<HTMLButtonElement> = (event) => {
    if (canToggle && !event.defaultPrevented) {
      onCaptureScroll(event.currentTarget);
    }
  };
  const handleKeyDown: KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (
      canToggle &&
      !event.defaultPrevented &&
      (event.key === "Enter" || event.key === " ")
    ) {
      onCaptureScroll(event.currentTarget);
    }
  };
  const handleClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    if (!canToggle || event.defaultPrevented) return;

    onCaptureScroll(event.currentTarget);
    onToggle(messageId, !expanded);
  };

  return (
    <button
      type="button"
      disabled={!canToggle}
      aria-expanded={canToggle ? expanded : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onTouchStart={handleTouchStart}
      className={`flex w-full items-center gap-2 border-b border-border pb-3 text-left text-sm text-muted-foreground transition-colors ${
        canToggle ? "hover:text-foreground" : "cursor-default"
      }`}
    >
      <span>{label}</span>
      {canToggle &&
        (expanded ? (
          <ChevronDownIcon className="size-4" />
        ) : (
          <ChevronRightIcon className="size-4" />
        ))}
    </button>
  );
});
