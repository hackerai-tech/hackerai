import { createAgentStatusPost } from "@/lib/api/agent-status-route";
import { LEGACY_AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

export const maxDuration = 30;

export const POST = createAgentStatusPost({
  endpoint: LEGACY_AGENT_API_ENDPOINT,
});
