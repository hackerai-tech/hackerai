import { MAX_TOKENS_PAID } from "@/lib/token-utils";
import type { StopCondition } from "ai";

/**
 * Token threshold for stopping the agent loop.
 * When accumulated tokens exceed this AND summarization has already occurred,
 * we stop to prevent runaway context growth.
 */
export const TOKEN_STOP_THRESHOLD = MAX_TOKENS_PAID; // 128K

/**
 * Finish reason string used when stopping due to token exhaustion after summarization.
 */
export const TOKEN_EXHAUSTION_FINISH_REASON = "context-limit";

/**
 * Creates a stop condition that fires when the last step's input tokens
 * (i.e. the current context window size) exceed the threshold AND
 * summarization has already been performed (meaning context has already
 * been compressed once and there's no more room to grow).
 *
 * Uses getter functions so callers can pass references to mutable closure variables.
 */
export function tokenExhaustedAfterSummarization(state: {
  getLastStepInputTokens: () => number;
  getHasSummarized: () => boolean;
  onFired: () => void;
}): StopCondition<any> {
  return () => {
    const lastStepInput = state.getLastStepInputTokens();
    const hasSummarized = state.getHasSummarized();
    const shouldStop = hasSummarized && lastStepInput > TOKEN_STOP_THRESHOLD;
    if (shouldStop) {
      state.onFired();
    }
    return shouldStop;
  };
}
