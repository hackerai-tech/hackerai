import { createAgentTriggerPost } from "@/lib/api/agent-trigger-route";
import { LEGACY_AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

// Match the canonical /api/agent startup budget for older clients.
export const maxDuration = 60;

export const POST = createAgentTriggerPost({
  endpoint: LEGACY_AGENT_API_ENDPOINT,
});
