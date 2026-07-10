import type { StopCondition } from "ai";
import {
  detectDoomLoop,
  type MinimalStep,
} from "@/lib/chat/doom-loop-detection";
export { AGENT_RUN_SPEND_CAP_FINISH_REASON } from "@/lib/chat/agent-run-spend-cap";

export const TOKEN_EXHAUSTION_FINISH_REASON = "context-limit";

export const BUDGET_EXHAUSTION_FINISH_REASON = "budget-exhausted";

export type AgentAutoContinueStopSource =
  | "post_summarization_token_exhaustion"
  | "elapsed_timeout"
  | "post_summarization_incomplete"
  | "context_limit_finish_reason"
  | "tool_calls_finish_reason";

export function getAgentAutoContinueStopSource(state: {
  finishReason: string | undefined;
  stoppedDueToTokenExhaustion: boolean;
  stoppedDueToElapsedTimeout?: boolean;
  stoppedDueToPostSummarizationIncomplete: boolean;
}): AgentAutoContinueStopSource | null {
  if (state.stoppedDueToTokenExhaustion) {
    return "post_summarization_token_exhaustion";
  }
  if (state.stoppedDueToElapsedTimeout) return "elapsed_timeout";
  if (state.stoppedDueToPostSummarizationIncomplete) {
    return "post_summarization_incomplete";
  }
  if (state.finishReason === TOKEN_EXHAUSTION_FINISH_REASON) {
    return "context_limit_finish_reason";
  }
  if (state.finishReason === "tool-calls") return "tool_calls_finish_reason";
  return null;
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

export const POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON =
  "compaction-incomplete";

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
