"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";

interface ComposerOverlayProps {
  active: boolean;
  children: ReactNode;
  onHeightChange: (height: number) => void;
}

export function ComposerOverlay({
  active,
  children,
  onHeightChange,
}: ComposerOverlayProps) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!active || !element) {
      onHeightChange(0);
      return;
    }

    const updateHeight = () => {
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      if (nextHeight > 0) {
        onHeightChange(nextHeight);
      }
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, element, onHeightChange]);

  return (
    <div
      ref={active ? setElement : undefined}
      data-chat-composer-overlay={active ? "true" : undefined}
      className={active ? "absolute inset-x-0 bottom-0 z-20" : "flex-shrink-0"}
    >
      {children}
    </div>
  );
}
