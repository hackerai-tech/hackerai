"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentProps, ReactNode } from "react";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "1s";
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds}s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

type WorkedForContextValue = {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  captureScrollPosition: (target: EventTarget | null) => void;
  hasWork: boolean;
};

const WorkedForContext = createContext<WorkedForContextValue | null>(null);

export const useWorkedFor = () => {
  const context = useContext(WorkedForContext);
  if (!context) {
    throw new Error("WorkedFor components must be used within WorkedFor");
  }
  return context;
};

export type WorkedForProps = ComponentProps<typeof Collapsible> & {
  hasWork: boolean;
  isTiming?: boolean;
};

type ScrollSnapshot = {
  element: HTMLElement;
  scrollLeft: number;
  scrollTop: number;
};

const getScrollableAncestor = (element: HTMLElement): HTMLElement | null => {
  let parent = element.parentElement;

  while (parent) {
    const { overflowY } = window.getComputedStyle(parent);
    const canScroll =
      (overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay") &&
      parent.scrollHeight > parent.clientHeight;

    if (canScroll) return parent;
    parent = parent.parentElement;
  }

  const scrollingElement = document.scrollingElement;
  return scrollingElement instanceof HTMLElement ? scrollingElement : null;
};

const now = () => Date.now();

export function WorkedFor({
  className,
  hasWork,
  isTiming = false,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: WorkedForProps) {
  const [isOpen, setIsOpen] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const scrollSnapshotRef = useRef<ScrollSnapshot | null>(null);
  const restoreTokenRef = useRef(0);
  const wasTimingRef = useRef(isTiming);

  const captureScrollPosition = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;

    const scrollElement = getScrollableAncestor(target);
    if (!scrollElement) return;
    if (scrollSnapshotRef.current?.element === scrollElement) return;

    scrollSnapshotRef.current = {
      element: scrollElement,
      scrollLeft: scrollElement.scrollLeft,
      scrollTop: scrollElement.scrollTop,
    };
  }, []);

  const restoreCapturedScrollPosition = useCallback(() => {
    const snapshot = scrollSnapshotRef.current;
    if (!snapshot) return;

    const token = restoreTokenRef.current + 1;
    restoreTokenRef.current = token;
    const start = now();
    const cancelRestore = () => {
      restoreTokenRef.current += 1;
      scrollSnapshotRef.current = null;
      snapshot.element.removeEventListener("wheel", cancelRestore);
      snapshot.element.removeEventListener("touchstart", cancelRestore);
      window.removeEventListener("keydown", cancelRestore);
    };

    snapshot.element.addEventListener("wheel", cancelRestore, { once: true });
    snapshot.element.addEventListener("touchstart", cancelRestore, {
      once: true,
    });
    window.addEventListener("keydown", cancelRestore, { once: true });

    const restore = () => {
      if (restoreTokenRef.current !== token) return;

      snapshot.element.scrollTop = snapshot.scrollTop;
      snapshot.element.scrollLeft = snapshot.scrollLeft;

      if (now() - start < 450) {
        requestAnimationFrame(restore);
        return;
      }

      snapshot.element.removeEventListener("wheel", cancelRestore);
      snapshot.element.removeEventListener("touchstart", cancelRestore);
      window.removeEventListener("keydown", cancelRestore);
      scrollSnapshotRef.current = null;
    };

    requestAnimationFrame(restore);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setIsOpen(nextOpen);
      restoreCapturedScrollPosition();
    },
    [restoreCapturedScrollPosition, setIsOpen],
  );

  useEffect(() => {
    const wasTiming = wasTimingRef.current;

    if (isTiming) {
      setIsOpen(true);
    } else if (wasTiming) {
      setIsOpen(false);
    }

    wasTimingRef.current = isTiming;
  }, [isTiming, setIsOpen]);

  const contextValue = useMemo(
    () => ({
      isOpen: !!isOpen,
      setIsOpen: handleOpenChange,
      captureScrollPosition,
      hasWork,
    }),
    [isOpen, handleOpenChange, captureScrollPosition, hasWork],
  );

  return (
    <WorkedForContext.Provider value={contextValue}>
      <Collapsible
        open={hasWork ? !!isOpen : false}
        onOpenChange={hasWork ? handleOpenChange : undefined}
        className={cn("not-prose w-full space-y-2", className)}
        {...props}
      >
        {children}
      </Collapsible>
    </WorkedForContext.Provider>
  );
}

export type WorkedForTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  durationMs?: number;
  startedAt?: number;
  label?: ReactNode;
  isTiming?: boolean;
};

export function WorkedForTrigger({
  className,
  durationMs,
  startedAt,
  isTiming = false,
  label,
  onClick,
  onKeyDown,
  onPointerDown,
  ...props
}: WorkedForTriggerProps) {
  const { isOpen, hasWork, captureScrollPosition } = useWorkedFor();
  const timingStartedAtRef = useRef<number | null>(null);
  const getElapsedMs = useCallback(() => {
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
      return 0;
    }

    return Math.max(0, Date.now() - startedAt);
  }, [startedAt]);
  const [elapsedMs, setElapsedMs] = useState(() => getElapsedMs());
  useEffect(() => {
    if (!isTiming) {
      timingStartedAtRef.current = null;
      return;
    }

    timingStartedAtRef.current =
      typeof startedAt === "number" && Number.isFinite(startedAt)
        ? startedAt
        : (timingStartedAtRef.current ?? Date.now());

    const updateElapsed = () => {
      setElapsedMs(
        Math.max(0, Date.now() - (timingStartedAtRef.current ?? Date.now())),
      );
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(intervalId);
  }, [isTiming, startedAt]);

  const text =
    label ??
    (isTiming
      ? `Working for ${formatDuration(elapsedMs)}`
      : typeof durationMs === "number" && durationMs > 0
        ? `Worked for ${formatDuration(durationMs)}`
        : "Worked");
  const canToggle = hasWork && !isTiming;
  const handlePointerDown: WorkedForTriggerProps["onPointerDown"] = (event) => {
    onPointerDown?.(event);
    if (!event.defaultPrevented && canToggle) {
      captureScrollPosition(event.currentTarget);
    }
  };
  const handleKeyDown: WorkedForTriggerProps["onKeyDown"] = (event) => {
    onKeyDown?.(event);
    if (
      !event.defaultPrevented &&
      canToggle &&
      (event.key === "Enter" || event.key === " ")
    ) {
      captureScrollPosition(event.currentTarget);
    }
  };
  const handleClick: WorkedForTriggerProps["onClick"] = (event) => {
    onClick?.(event);
    if (!event.defaultPrevented && canToggle) {
      captureScrollPosition(event.currentTarget);
    }
  };

  return (
    <CollapsibleTrigger
      disabled={!canToggle}
      className={cn(
        "flex items-center gap-2 text-muted-foreground text-sm transition-colors border-b border-border pb-3 w-full",
        canToggle && "hover:text-foreground",
        !canToggle && "cursor-default",
        className,
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      {...props}
    >
      <span>{text}</span>
      {canToggle &&
        (isOpen ? (
          <ChevronDownIcon className="size-4" />
        ) : (
          <ChevronRightIcon className="size-4" />
        ))}
    </CollapsibleTrigger>
  );
}

export type WorkedForContentProps = Omit<
  ComponentProps<typeof CollapsibleContent>,
  "children"
> & {
  children: ReactNode | (() => ReactNode);
  lazy?: boolean;
};

export function WorkedForContent({
  className,
  children,
  lazy = false,
  ...props
}: WorkedForContentProps) {
  const { isOpen } = useWorkedFor();
  const shouldRenderChildren = !lazy || isOpen;

  return (
    <CollapsibleContent
      className={cn("worked-for-content mt-2 space-y-3", className)}
      {...props}
    >
      {shouldRenderChildren
        ? typeof children === "function"
          ? children()
          : children
        : null}
    </CollapsibleContent>
  );
}

WorkedFor.displayName = "WorkedFor";
WorkedForTrigger.displayName = "WorkedForTrigger";
WorkedForContent.displayName = "WorkedForContent";
