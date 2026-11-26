import { createAgentTriggerPost } from "@/lib/api/agent-trigger-route";
import { createAgentCancelPost } from "@/lib/api/agent-cancel-route";
import { createLocalAutoContinuePost } from "@/lib/api/local-auto-continue-route";
import { AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

// Room for one Agent start (its own 60 s budget) plus its short retries.
export const maxDuration = 90;

export const POST = createLocalAutoContinuePost({
  startAgent: createAgentTriggerPost({ endpoint: AGENT_API_ENDPOINT }),
  cancelAgent: createAgentCancelPost({ endpoint: AGENT_API_ENDPOINT }),
});
