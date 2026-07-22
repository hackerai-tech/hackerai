import type { Todo } from "@/types";

export const AGENT_COMPLETION_SIGNAL_VERSION = 1;

export type AgentCompletionSignalTracker = {
  stepCount: number;
  handledToolFailureCount: number;
  sdkToolErrorCount: number;
  handledToolFailurePendingStep: boolean;
  stepsSinceLastToolFailure?: number;
};

export type AgentCompletionSignals = {
  version: typeof AGENT_COMPLETION_SIGNAL_VERSION;
  naturalStop: boolean;
  stepCount: number;
  todoTotalCount: number;
  todoPendingCount: number;
  todoInProgressCount: number;
  hasUnfinishedTodos: boolean;
  handledToolFailureCount: number;
  sdkToolErrorCount: number;
  hasToolFailure: boolean;
  recentToolFailure: boolean;
  stepsSinceLastToolFailure?: number;
};

export const createAgentCompletionSignalTracker =
  (): AgentCompletionSignalTracker => ({
    stepCount: 0,
    handledToolFailureCount: 0,
    sdkToolErrorCount: 0,
    handledToolFailurePendingStep: false,
    stepsSinceLastToolFailure: undefined,
  });

/** Record a handled tool failure without retaining the tool name or payload. */
export const recordHandledToolFailure = (
  tracker: AgentCompletionSignalTracker,
): void => {
  tracker.handledToolFailureCount += 1;
  tracker.handledToolFailurePendingStep = true;
};

/** Record one model step and count only AI SDK tool-error part types. */
export const recordAgentStepCompletion = (
  tracker: AgentCompletionSignalTracker,
  content: unknown,
): void => {
  tracker.stepCount += 1;

  const sdkToolErrors = Array.isArray(content)
    ? content.filter(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "tool-error",
      ).length
    : 0;
  tracker.sdkToolErrorCount += sdkToolErrors;

  if (tracker.handledToolFailurePendingStep || sdkToolErrors > 0) {
    tracker.stepsSinceLastToolFailure = 0;
  } else if (tracker.stepsSinceLastToolFailure !== undefined) {
    tracker.stepsSinceLastToolFailure += 1;
  }
  tracker.handledToolFailurePendingStep = false;
};

export const buildAgentCompletionSignals = ({
  outcome,
  finishReason,
  todos,
  tracker,
}: {
  outcome: "success" | "aborted" | "error";
  finishReason?: string;
  todos: Todo[];
  tracker: AgentCompletionSignalTracker;
}): AgentCompletionSignals => {
  const todoPendingCount = todos.filter(
    (todo) => todo.status === "pending",
  ).length;
  const todoInProgressCount = todos.filter(
    (todo) => todo.status === "in_progress",
  ).length;
  const hasToolFailure =
    tracker.handledToolFailureCount + tracker.sdkToolErrorCount > 0;

  return {
    version: AGENT_COMPLETION_SIGNAL_VERSION,
    naturalStop: outcome === "success" && finishReason === "stop",
    stepCount: tracker.stepCount,
    todoTotalCount: todos.length,
    todoPendingCount,
    todoInProgressCount,
    hasUnfinishedTodos: todoPendingCount + todoInProgressCount > 0,
    handledToolFailureCount: tracker.handledToolFailureCount,
    sdkToolErrorCount: tracker.sdkToolErrorCount,
    hasToolFailure,
    recentToolFailure:
      tracker.stepsSinceLastToolFailure !== undefined &&
      tracker.stepsSinceLastToolFailure <= 1,
    stepsSinceLastToolFailure: tracker.stepsSinceLastToolFailure,
  };
};
