"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  captureAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";

export function sampleBrowserPerformance(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++)
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return (hash >>> 0) % 10 === 0;
}

/** No keys, DOM text, selectors, URLs, or PerformanceEntry objects leave here. */
export function observeBrowserResponsiveness(owner: string) {
  const empty = () => ({
    input_count: 0,
    input_frame_delay_max_ms: 0,
    scroll_count: 0,
    scroll_frame_gap_max_ms: 0,
    long_task_count: 0,
    long_task_total_ms: 0,
    long_task_max_ms: 0,
    event_timing_entry_count: 0,
    event_timing_duration_max_ms: 0,
  });
  let metrics = empty();
  let started = performance.now();
  let inputFrame = 0;
  let scrollFrame = 0;
  let previousScrollFrame: number | null = null;
  let lastScroll = 0;
  let visible = document.visibilityState === "visible";
  const observers: PerformanceObserver[] = [];
  const supported =
    typeof PerformanceObserver === "undefined"
      ? []
      : (PerformanceObserver.supportedEntryTypes ?? []);
  const flush = () => {
    if (
      owner === getIdentifiedAnalyticsUserId() &&
      Object.values(metrics).some((value) => value > 0)
    ) {
      captureAuthenticatedEvent("chat_browser_responsiveness", {
        ...Object.fromEntries(
          Object.entries(metrics).map(([key, value]) => [
            key,
            Math.round(value),
          ]),
        ),
        observation_ms: Math.round(performance.now() - started),
        performance_event_version: 1,
        telemetry_sample_rate: 0.1,
        long_task_supported: supported.includes("longtask"),
        event_timing_supported: supported.includes("event"),
        route_kind: "chat",
      });
    }
    metrics = empty();
    started = performance.now();
  };
  const onInput = (event: Event) => {
    if (!visible || !(event.target instanceof HTMLTextAreaElement)) return;
    metrics.input_count++;
    if (inputFrame) return;
    const inputAt = performance.now();
    inputFrame = requestAnimationFrame(() => {
      inputFrame = 0;
      if (visible)
        metrics.input_frame_delay_max_ms = Math.max(
          metrics.input_frame_delay_max_ms,
          performance.now() - inputAt,
        );
    });
  };
  const scrollTick = (now: number) => {
    scrollFrame = 0;
    if (!visible) return;
    if (previousScrollFrame !== null)
      metrics.scroll_frame_gap_max_ms = Math.max(
        metrics.scroll_frame_gap_max_ms,
        now - previousScrollFrame,
      );
    previousScrollFrame = now;
    if (now - lastScroll < 150) scrollFrame = requestAnimationFrame(scrollTick);
    else previousScrollFrame = null;
  };
  const onScroll = () => {
    if (!visible) return;
    metrics.scroll_count++;
    lastScroll = performance.now();
    if (!scrollFrame) {
      previousScrollFrame = lastScroll;
      scrollFrame = requestAnimationFrame(scrollTick);
    }
  };
  for (const type of ["longtask", "event"]) {
    if (!supported.includes(type)) continue;
    try {
      const observer = new PerformanceObserver((list) => {
        if (!visible) return;
        for (const entry of list.getEntries()) {
          if (entry.startTime < started) continue;
          if (type === "longtask") {
            metrics.long_task_count++;
            metrics.long_task_total_ms += entry.duration;
            metrics.long_task_max_ms = Math.max(
              metrics.long_task_max_ms,
              entry.duration,
            );
          } else {
            metrics.event_timing_entry_count++;
            metrics.event_timing_duration_max_ms = Math.max(
              metrics.event_timing_duration_max_ms,
              entry.duration,
            );
          }
        }
      });
      observer.observe({
        type,
        buffered: false,
        ...(type === "event" ? { durationThreshold: 16 } : {}),
      });
      observers.push(observer);
    } catch {
      /* Unsupported browsers still report frame-delay proxies. */
    }
  }
  const onVisibility = () => {
    flush();
    visible = document.visibilityState === "visible";
    cancelAnimationFrame(inputFrame);
    cancelAnimationFrame(scrollFrame);
    inputFrame = scrollFrame = 0;
    previousScrollFrame = null;
  };
  document.addEventListener("input", onInput, { passive: true });
  document.addEventListener("scroll", onScroll, {
    passive: true,
    capture: true,
  });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", flush);
  const interval = setInterval(flush, 60_000);
  return () => {
    clearInterval(interval);
    observers.forEach((observer) => observer.disconnect());
    document.removeEventListener("input", onInput);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", flush);
    cancelAnimationFrame(inputFrame);
    cancelAnimationFrame(scrollFrame);
    flush();
  };
}

export function useBrowserResponsiveness() {
  const owner = useSyncExternalStore(
    subscribeAuthenticatedAnalytics,
    getIdentifiedAnalyticsUserId,
    () => null,
  );
  useEffect(() => {
    if (owner && sampleBrowserPerformance(owner))
      return observeBrowserResponsiveness(owner);
  }, [owner]);
}
