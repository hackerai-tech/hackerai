export const FREE_AGENT_COMPLETED_DAILY_KEY = "free-agent-completed-daily-v1";
export const FREE_AGENT_COMPLETED_DAILY_EXPOSURE = "$feature_flag_called";

export type FreeAgentDailyAssignment = { variant: "control" | "test" };
export type FreeAgentDailyStatus = {
  assignment: FreeAgentDailyAssignment;
  completed: boolean;
  resetTimestamp: number;
};

export function freeAgentDailyExposureProperties(
  assignment: FreeAgentDailyAssignment,
  surface: "composer" | "agent" | "agent_worker",
) {
  return {
    $feature_flag: FREE_AGENT_COMPLETED_DAILY_KEY,
    $feature_flag_response: assignment.variant,
    [`$feature/${FREE_AGENT_COMPLETED_DAILY_KEY}`]: assignment.variant,
    exposure_surface: surface,
    mode: "agent",
    subscription_tier: "free",
    $geoip_disable: true,
    $process_person_profile: false,
  };
}
