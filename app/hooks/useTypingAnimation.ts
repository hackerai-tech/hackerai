"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

interface UseTypingAnimationOptions {
  phrases: string[];
  enabled: boolean;
  typingSpeedMs?: number;
  deletingSpeedMs?: number;
  pauseAfterTypeMs?: number;
  pauseAfterDeleteMs?: number;
  startDelayMs?: number;
  /** Per-keystroke timing jitter on a 0..1 scale (±variance * 100%). */
  variance?: number;
}

// Multipliers applied to the delay *after* the given character is typed, so
// the beat lands after punctuation rather than before it.
const PAUSE_AFTER_CHAR: Record<string, number> = {
  ".": 4,
  "!": 4,
  "?": 4,
  ",": 3,
  ";": 3,
  ":": 3,
  " ": 1.8,
};

function jitter(ms: number, variance: number): number {
  if (variance <= 0) return ms;
  const factor = 1 + (Math.random() - 0.5) * 2 * variance;
  return Math.max(10, ms * factor);
}

function subscribeReducedMotion(callback: () => void): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getReducedMotionServerSnapshot(): boolean {
  return false;
}

export function useTypingAnimation({
  phrases,
  enabled,
  typingSpeedMs = 55,
  deletingSpeedMs = 30,
  pauseAfterTypeMs = 1800,
  pauseAfterDeleteMs = 400,
  startDelayMs = 400,
  variance = 0.35,
}: UseTypingAnimationOptions): string {
  const [text, setText] = useState("");
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );

  useEffect(() => {
    if (!enabled || phrases.length === 0 || reducedMotion) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, ms);
      });

    const run = async () => {
      await wait(startDelayMs);
      if (cancelled) return;

      let index = 0;
      while (!cancelled) {
        const phrase = phrases[index];

        for (let len = 1; len <= phrase.length; len++) {
          // Pause multiplier is driven by the *previous* character so the
          // beat lands after punctuation. Skip when the previous char repeats
          // (e.g. "...") so ellipses don't stall.
          const prevChar = phrase[len - 2];
          const nextChar = phrase[len - 1];
          const multiplier =
            prevChar && prevChar !== nextChar
              ? (PAUSE_AFTER_CHAR[prevChar] ?? 1)
              : 1;

          await wait(jitter(typingSpeedMs * multiplier, variance));
          if (cancelled) return;
          setText(phrase.slice(0, len));
        }

        await wait(pauseAfterTypeMs);
        if (cancelled) return;

        // Deletion feels mechanical (holding backspace), so use less jitter.
        for (let len = phrase.length - 1; len >= 0; len--) {
          await wait(jitter(deletingSpeedMs, variance * 0.3));
          if (cancelled) return;
          setText(phrase.slice(0, len));
        }

        await wait(pauseAfterDeleteMs);
        if (cancelled) return;
        index = (index + 1) % phrases.length;
      }
    };

    run();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [
    enabled,
    phrases,
    reducedMotion,
    typingSpeedMs,
    deletingSpeedMs,
    pauseAfterTypeMs,
    pauseAfterDeleteMs,
    startDelayMs,
    variance,
  ]);

  if (!enabled || phrases.length === 0) return "";
  if (reducedMotion) return phrases[0];
  return text;
}
