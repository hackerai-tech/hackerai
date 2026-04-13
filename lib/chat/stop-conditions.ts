import type { StopCondition } from "ai";
import {
  detectDoomLoop,
  type MinimalStep,
} from "@/lib/chat/doom-loop-detection";

export const TOKEN_EXHAUSTION_FINISH_REASON = "context-limit";

export function tokenExhaustedAfterSummarization(state: {
  threshold: number;
  getLastStepInputTokens: () => number;
  getHasSummarized: () => boolean;
  onFired: () => void;
}): StopCondition<any> {
  return () => {
    const lastStepInput = state.getLastStepInputTokens();
    const hasSummarized = state.getHasSummarized();
    const shouldStop = hasSummarized && lastStepInput > state.threshold;
    if (shouldStop) {
      state.onFired();
    }
    return shouldStop;
  };
}

export const PREEMPTIVE_TIMEOUT_FINISH_REASON = "preemptive-timeout";
export const AGENT_MAX_STREAM_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export function elapsedTimeExceeds(state: {
  maxDurationMs: number;
  getStartTime: () => number;
  onFired: () => void;
}): StopCondition<any> {
  return () => {
    const elapsed = Date.now() - state.getStartTime();
    const shouldStop = elapsed >= state.maxDurationMs;
    if (shouldStop) state.onFired();
    return shouldStop;
  };
}

export const DOOM_LOOP_FINISH_REASON = "doom-loop";

export function doomLoopDetected(state: {
  onFired: () => void;
}): StopCondition<any> {
  return ({ steps }) => {
    const result = detectDoomLoop(steps as unknown as MinimalStep[]);
    if (result.severity === "halt") {
      state.onFired();
      return true;
    }
    return false;
  };
}
