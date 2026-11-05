"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/types";
import { ChatPerformanceTracker } from "@/lib/analytics/chat-performance";
import { subscribeAuthenticatedAnalytics } from "@/lib/analytics/client";

// This is a rendered-text proxy, not token arrival or guaranteed display pixels.
// Two animation frames allow the committed text a paint opportunity. Checking
// bounds avoids counting virtualized/offscreen history as visible output.
export function useChatPerformance({
  tracker,
  chatId,
  messages,
  status,
  runId,
}: {
  tracker: ChatPerformanceTracker;
  chatId: string;
  messages: ChatMessage[];
  status: string;
  runId?: string | null;
}) {
  const observed = useRef<{
    sampleId: string;
    messageId: string;
    length: number;
  } | null>(null);
  useEffect(() => {
    const unsubscribe = subscribeAuthenticatedAnalytics(() =>
      tracker.reconcileIdentity(),
    );
    const onVisibility = () => {
      if (document.visibilityState !== "visible") tracker.background();
    };
    const onPageHide = () => tracker.finish("navigated");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      tracker.finish("navigated");
    };
  }, [tracker, chatId]);

  useEffect(() => {
    tracker.setRunId(runId);
    const sampleId = tracker.id;
    if (!sampleId) return;
    const message = messages.findLast(
      (item) => item.role === "assistant" && tracker.accepts(item.id),
    );
    const terminal = status === "ready" || status === "error";
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (tracker.id !== sampleId) return;
        if (message && document.visibilityState === "visible") {
          const nodes = document.querySelectorAll<HTMLElement>(
            `[data-performance-message-id="${CSS.escape(message.id)}"]`,
          );
          const length = Array.from(nodes).reduce((total, node) => {
            const rect = node.getBoundingClientRect();
            const viewport = node
              .closest('[data-testid="messages-container"]')
              ?.getBoundingClientRect();
            const visible =
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > Math.max(0, viewport?.top ?? 0) &&
              rect.top <
                Math.min(
                  window.innerHeight,
                  viewport?.bottom ?? window.innerHeight,
                ) &&
              rect.right > 0 &&
              rect.left < window.innerWidth;
            return (
              total +
              (visible ? Number(node.dataset.performanceTextLength) || 0 : 0)
            );
          }, 0);
          if (
            length > 0 &&
            (observed.current?.sampleId !== sampleId ||
              observed.current.messageId !== message.id ||
              observed.current.length !== length)
          ) {
            tracker.textPainted(sampleId);
            observed.current = { sampleId, messageId: message.id, length };
          }
        }
        if (terminal) tracker.finish(status === "error" ? "error" : undefined);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [tracker, chatId, messages, status, runId]);
}
