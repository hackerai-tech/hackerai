"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, CornerDownRight, X } from "lucide-react";
import { useCommittedRef } from "@/app/hooks/useLatestRef";
import type { NextActionsController } from "@/app/hooks/useNextActions";

export function NextMessagePredictions({
  controller,
  showKeyboardHint = false,
  onFocusComposer,
}: {
  controller: NextActionsController;
  showKeyboardHint?: boolean;
  onFocusComposer?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pointerType = useRef("mouse");
  const alternativesId = useId();
  const exposed = useCommittedRef(controller.exposed);
  const batch = controller.batch;
  useEffect(() => {
    if (!batch || !root.current) return;
    let visible = false;
    const record = () => {
      if (visible && document.visibilityState === "visible") exposed.current();
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        record();
      },
      { threshold: 0.5 },
    );
    observer.observe(root.current);
    document.addEventListener("visibilitychange", record);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", record);
    };
  }, [batch, exposed]);
  if (!batch) return null;
  const restoreFocus = (detail: number) => {
    if (detail === 0 || pointerType.current === "mouse") onFocusComposer?.();
  };
  const accept = (index: number, detail: number) => {
    if (controller.accept(index, detail === 0 ? "keyboard" : "pointer"))
      restoreFocus(detail);
  };
  const buttonClass =
    "min-h-11 min-w-0 flex-1 rounded-xl px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9";
  return (
    <div
      ref={root}
      role="group"
      aria-label="Suggested next messages"
      className="ph-no-capture ph-mask mb-2 w-fit min-w-0 max-w-full rounded-2xl border border-border/60 bg-background/80 p-1"
      onPointerDownCapture={(event) => {
        pointerType.current = event.pointerType;
        // Mouse acceptance keeps the editing context; touch never summons a keyboard.
        if (event.pointerType === "mouse") event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          controller.dismiss();
          onFocusComposer?.();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className={`${buttonClass} flex items-center gap-2`}
          onClick={(event) => accept(0, event.detail)}
        >
          <CornerDownRight className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="line-clamp-2 break-words">
            {batch.suggestions[0]}
          </span>
          {showKeyboardHint && (
            <kbd
              aria-hidden="true"
              className="ml-auto hidden shrink-0 rounded border px-1 text-[11px] md:inline"
            >
              Tab
            </kbd>
          )}
        </button>
        {batch.suggestions.length > 1 && (
          <button
            type="button"
            aria-label={
              expanded
                ? "Hide alternative suggestions"
                : "Show alternative suggestions"
            }
            aria-expanded={expanded}
            aria-controls={expanded ? alternativesId : undefined}
            className="flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-xl text-xs text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
            onClick={() => setExpanded(!expanded)}
          >
            <span className="hidden md:inline">
              {expanded ? "Less" : `${batch.suggestions.length - 1} more`}
            </span>
            {expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss suggestions"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
          onClick={(event) => {
            controller.dismiss();
            restoreFocus(event.detail);
          }}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      {expanded && (
        <div
          id={alternativesId}
          className="flex flex-col border-t border-border/60 pt-1"
        >
          {batch.suggestions.slice(1).map((text, index) => (
            <button
              key={text}
              type="button"
              className={`${buttonClass} flex items-center gap-2`}
              onClick={(event) => accept(index + 1, event.detail)}
            >
              <CornerDownRight
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span className="line-clamp-2 break-words">{text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
