import { createAgentTriggerPost } from "@/lib/api/agent-trigger-route";
import { AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

export const maxDuration = 30;

export const POST = createAgentTriggerPost({
  endpoint: AGENT_API_ENDPOINT,
});
