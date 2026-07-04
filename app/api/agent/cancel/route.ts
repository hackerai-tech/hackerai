import { createAgentCancelPost } from "@/lib/api/agent-cancel-route";
import { AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

export const maxDuration = 30;

export const POST = createAgentCancelPost({
  endpoint: AGENT_API_ENDPOINT,
});
