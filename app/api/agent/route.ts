import { createAgentTriggerPost } from "@/lib/api/agent-trigger-route";
import { AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

// Leave time for a slow Trigger handoff and durable chat association.
// Keep the browser's startup deadline longer than this route budget.
export const maxDuration = 60;

export const POST = createAgentTriggerPost({
  endpoint: AGENT_API_ENDPOINT,
});
