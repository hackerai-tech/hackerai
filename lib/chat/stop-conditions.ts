import type { StopCondition } from "ai";

export const TOKEN_EXHAUSTION_FINISH_REASON = "context-limit";
export const WORKFLOW_CHECKPOINT_FINISH_REASON = "workflow-checkpoint";

export function timeBudgetExceeded(state: {
  budgetMs: number;
  getStartTime: () => number;
  onFired: () => void;
}): StopCondition<any> {
  return () => {
    const elapsed = Date.now() - state.getStartTime();
    const shouldStop = elapsed >= state.budgetMs;
    if (shouldStop) state.onFired();
    return shouldStop;
  };
}

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
