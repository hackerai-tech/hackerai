import { createAgentApprovalPost } from "@/lib/api/agent-approval-route";
import { AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

export const maxDuration = 30;

export const POST = createAgentApprovalPost({
  endpoint: AGENT_API_ENDPOINT,
});
