import { describe, expect, it } from "@jest/globals";

import {
  buildAgentCompletionSignals,
  createAgentCompletionSignalTracker,
  recordAgentStepCompletion,
  recordHandledToolFailure,
} from "../agent-completion-signals";

describe("agent completion signals", () => {
  it("tracks steps and failure proximity without retaining tool content", () => {
    const tracker = createAgentCompletionSignalTracker();

    recordHandledToolFailure(tracker);
    recordAgentStepCompletion(tracker, [
      { type: "tool-error", error: "SECRET_TOOL_ERROR" },
      { type: "text", text: "SECRET_ASSISTANT_TEXT" },
    ]);
    recordAgentStepCompletion(tracker, [{ type: "text", text: "done" }]);

    expect(tracker).toEqual({
      stepCount: 2,
      handledToolFailureCount: 1,
      sdkToolErrorCount: 1,
      handledToolFailurePendingStep: false,
      stepsSinceLastToolFailure: 1,
    });
    expect(JSON.stringify(tracker)).not.toContain("SECRET");
  });

  it("builds content-free signals for a suspicious natural stop", () => {
    const tracker = createAgentCompletionSignalTracker();
    recordHandledToolFailure(tracker);
    recordAgentStepCompletion(tracker, []);
    recordAgentStepCompletion(tracker, []);

    const signals = buildAgentCompletionSignals({
      outcome: "success",
      finishReason: "stop",
      todos: [
        {
          id: "todo-1",
          content: "SECRET_PENDING_TODO",
          status: "pending",
        },
        {
          id: "todo-2",
          content: "SECRET_ACTIVE_TODO",
          status: "in_progress",
        },
        {
          id: "todo-3",
          content: "SECRET_COMPLETED_TODO",
          status: "completed",
        },
      ],
      tracker,
    });

    expect(signals).toEqual({
      version: 1,
      naturalStop: true,
      stepCount: 2,
      todoTotalCount: 3,
      todoPendingCount: 1,
      todoInProgressCount: 1,
      hasUnfinishedTodos: true,
      handledToolFailureCount: 1,
      sdkToolErrorCount: 0,
      hasToolFailure: true,
      recentToolFailure: true,
      stepsSinceLastToolFailure: 1,
    });
    expect(JSON.stringify(signals)).not.toContain("SECRET");
  });

  it("does not classify limits or aborts as natural stops", () => {
    const tracker = createAgentCompletionSignalTracker();

    expect(
      buildAgentCompletionSignals({
        outcome: "success",
        finishReason: "tool-calls",
        todos: [],
        tracker,
      }).naturalStop,
    ).toBe(false);
    expect(
      buildAgentCompletionSignals({
        outcome: "aborted",
        finishReason: "stop",
        todos: [],
        tracker,
      }).naturalStop,
    ).toBe(false);
  });
});
