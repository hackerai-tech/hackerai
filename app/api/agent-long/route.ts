import { createAgentTriggerPost } from "@/lib/api/agent-trigger-route";
import { LEGACY_AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

export const maxDuration = 30;

export const POST = createAgentTriggerPost({
  endpoint: LEGACY_AGENT_API_ENDPOINT,
});
