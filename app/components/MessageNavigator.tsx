"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { cn } from "@/lib/utils";
import {
  MESSAGE_NAVIGATOR_MIN_ITEMS,
  resolveMessageNavigatorHasPersistentGutter,
  resolveMessageNavigatorHeightStyle,
  resolveMessageNavigatorHitStripWidth,
  resolveMessageNavigatorIndexFromPointer,
  resolveMessageNavigatorTopPercent,
  type MessageNavigatorItem,
} from "./message-navigator";

interface MessageNavigatorProps {
  items: ReadonlyArray<MessageNavigatorItem>;
  scrollElement: HTMLElement | null;
  onSelect: (item: MessageNavigatorItem) => void;
}

export const MessageNavigator = memo(function MessageNavigator({
  items,
  scrollElement,
  onSelect,
}: MessageNavigatorProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const stripMapRef = useRef(new Map<string, HTMLSpanElement>());

  const itemIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem =
    resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const hasPersistentGutter =
    resolveMessageNavigatorHasPersistentGutter(viewportWidth);
  const hitStripWidth = resolveMessageNavigatorHitStripWidth(viewportWidth);

  const updateInViewMarkers = useCallback(() => {
    if (!scrollElement) {
      return;
    }

    const viewportRect = scrollElement.getBoundingClientRect();
    const inViewIds = new Set<string>();
    const messageRows =
      scrollElement.querySelectorAll<HTMLElement>("[data-message-id]");

    for (const row of messageRows) {
      const messageId = row.dataset.messageId;
      if (!messageId || !itemIds.has(messageId)) {
        continue;
      }

      const rowRect = row.getBoundingClientRect();
      if (
        rowRect.top < viewportRect.bottom &&
        rowRect.bottom > viewportRect.top
      ) {
        inViewIds.add(messageId);
      }
    }

    for (const item of items) {
      const strip = stripMapRef.current.get(item.id);
      if (strip) {
        strip.dataset.inView = inViewIds.has(item.id) ? "true" : "false";
      }
    }
  }, [itemIds, items, scrollElement]);

  useEffect(() => {
    if (!scrollElement) {
      return;
    }

    const measure = () => {
      const nextWidth = scrollElement.getBoundingClientRect().width;
      setViewportWidth((current) =>
        current === nextWidth ? current : nextWidth,
      );
      updateInViewMarkers();
    };

    const frame = requestAnimationFrame(measure);
    if (typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(frame);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(scrollElement);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [scrollElement, updateInViewMarkers]);

  useEffect(() => {
    if (!scrollElement) {
      return;
    }

    const frame = requestAnimationFrame(updateInViewMarkers);
    scrollElement.addEventListener("scroll", updateInViewMarkers, {
      passive: true,
    });
    return () => {
      cancelAnimationFrame(frame);
      scrollElement.removeEventListener("scroll", updateInViewMarkers);
    };
  }, [scrollElement, updateInViewMarkers]);

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveMessageNavigatorIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActiveIndex(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActiveIndex(-1);
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(items.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (activeItem) {
          onSelect(activeItem);
        }
      }
    },
    [activeItem, items.length, moveActiveIndex, onSelect],
  );

  if (items.length < MESSAGE_NAVIGATOR_MIN_ITEMS) {
    return null;
  }

  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveMessageNavigatorTopPercent(resolvedActiveIndex, items.length);
  const activePreviewTranslate =
    resolvedActiveIndex === 0
      ? "0%"
      : resolvedActiveIndex === items.length - 1
        ? "-100%"
        : "-50%";

  return (
    <div
      className={cn(
        "group/message-navigator pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-[72px] [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      data-testid="message-navigator"
    >
      <div className="relative h-full w-full select-none">
        <button
          type="button"
          aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            const nextIndex = resolveActiveIndexFromPointer(event);
            const nextItem =
              nextIndex === null ? null : (items[nextIndex] ?? null);
            if (nextItem) {
              onSelect(nextItem);
            }
            event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={handleKeyDown}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={(event) => {
            setActiveIndex(resolveActiveIndexFromPointer(event));
          }}
          style={{
            height: resolveMessageNavigatorHeightStyle(items.length),
            width: hitStripWidth,
          }}
        >
          {items.map((item, index) => {
            const activeDistance =
              resolvedActiveIndex === null
                ? null
                : Math.abs(index - resolvedActiveIndex);

            return (
              <span
                key={item.id}
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  activeDistance === 0
                    ? "w-7 bg-muted-foreground/75"
                    : activeDistance === 1
                      ? "w-[22px]"
                      : activeDistance === 2
                        ? "w-3.5"
                        : "w-2",
                )}
                data-in-view="false"
                data-message-navigator-strip
                ref={(node) => {
                  if (node) {
                    stripMapRef.current.set(item.id, node);
                  } else {
                    stripMapRef.current.delete(item.id);
                  }
                }}
                style={{
                  top: `${resolveMessageNavigatorTopPercent(index, items.length)}%`,
                }}
              />
            );
          })}

          {activeItem ? (
            <span
              className="pointer-events-none absolute left-8 w-80"
              data-message-navigator-preview
              data-testid="message-navigator-preview"
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activePreviewTranslate})`,
              }}
            >
              <span className="message-navigator-preview-glass block rounded-xl p-3 text-left text-popover-foreground">
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                  {activeItem.userText ?? "User message"}
                </span>
                {activeItem.assistantText ? (
                  <span
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-sm leading-5 text-muted-foreground"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                    }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
});
