import type { TodoRunMetrics } from "@/lib/ai/tools/utils/todo-manager";

// Version 2 adds finalStepHasText.
export const AGENT_STEP_LIMIT_TELEMETRY_VERSION = 2;

export type AgentStepLimitTelemetry = TodoRunMetrics & {
  version: typeof AGENT_STEP_LIMIT_TELEMETRY_VERSION;
  configuredMaxSteps: number;
  stepCount: number;
  stepLimitReached: boolean;
  /** The last completed model step produced text. Content-free. */
  finalStepHasText: boolean;
};

/** Build content-free measurements for deciding whether the Agent step cap is too low. */
export const buildAgentStepLimitTelemetry = ({
  configuredMaxSteps,
  stepCount,
  stepLimitReached,
  finalStepHasText,
  todoRunMetrics,
}: {
  configuredMaxSteps: number;
  stepCount: number;
  stepLimitReached: boolean;
  finalStepHasText: boolean;
  todoRunMetrics: TodoRunMetrics;
}): AgentStepLimitTelemetry => ({
  version: AGENT_STEP_LIMIT_TELEMETRY_VERSION,
  configuredMaxSteps,
  stepCount,
  stepLimitReached,
  finalStepHasText,
  ...todoRunMetrics,
});
