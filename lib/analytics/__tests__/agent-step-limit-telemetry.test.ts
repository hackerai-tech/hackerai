import { describe, expect, it } from "@jest/globals";

import { buildAgentStepLimitTelemetry } from "../agent-step-limit-telemetry";

describe("agent step-limit telemetry", () => {
  it("builds a content-free snapshot from explicit stop and todo-run state", () => {
    expect(
      buildAgentStepLimitTelemetry({
        configuredMaxSteps: 300,
        stepCount: 300,
        stepLimitReached: true,
        finalStepHasText: true,
        todoRunMetrics: {
          initialTodoCount: 4,
          initialUnfinishedTodoCount: 2,
          finalTodoCount: 5,
          finalUnfinishedTodoCount: 2,
          todoWriteCount: 3,
          todoCreatedThisRunCount: 2,
          todoUpdatedThisRunCount: 1,
          todoRemovedThisRunCount: 1,
          currentRunTodoCount: 3,
          currentRunUnfinishedTodoCount: 1,
        },
      }),
    ).toEqual({
      version: 2,
      configuredMaxSteps: 300,
      stepCount: 300,
      stepLimitReached: true,
      finalStepHasText: true,
      initialTodoCount: 4,
      initialUnfinishedTodoCount: 2,
      finalTodoCount: 5,
      finalUnfinishedTodoCount: 2,
      todoWriteCount: 3,
      todoCreatedThisRunCount: 2,
      todoUpdatedThisRunCount: 1,
      todoRemovedThisRunCount: 1,
      currentRunTodoCount: 3,
      currentRunUnfinishedTodoCount: 1,
    });
  });
});
