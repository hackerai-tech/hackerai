import type { TodoRunMetrics } from "@/lib/ai/tools/utils/todo-manager";

export const AGENT_STEP_LIMIT_TELEMETRY_VERSION = 1;

export type AgentStepLimitTelemetry = TodoRunMetrics & {
  version: typeof AGENT_STEP_LIMIT_TELEMETRY_VERSION;
  configuredMaxSteps: number;
  stepCount: number;
  stepLimitReached: boolean;
};

/** Build content-free measurements for deciding whether the Agent step cap is too low. */
export const buildAgentStepLimitTelemetry = ({
  configuredMaxSteps,
  stepCount,
  stepLimitReached,
  todoRunMetrics,
}: {
  configuredMaxSteps: number;
  stepCount: number;
  stepLimitReached: boolean;
  todoRunMetrics: TodoRunMetrics;
}): AgentStepLimitTelemetry => ({
  version: AGENT_STEP_LIMIT_TELEMETRY_VERSION,
  configuredMaxSteps,
  stepCount,
  stepLimitReached,
  ...todoRunMetrics,
});
