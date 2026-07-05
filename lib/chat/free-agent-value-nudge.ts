export const FREE_AGENT_VALUE_NUDGE_PART_TYPE =
  "data-free-agent-value-nudge" as const;

export const FREE_AGENT_VALUE_NUDGE_STORAGE_PREFIX =
  "free-agent-value-nudge:" as const;

export const FREE_AGENT_VALUE_NUDGE_ANALYTICS = {
  surface: "free_agent_value_nudge",
  source: "free_agent_value_reached",
  reason: "post_success_agent_run",
  from_tier: "free",
  cta_text: "Upgrade for cloud Agent",
} as const;
