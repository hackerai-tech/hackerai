import { createAgentApprovalPost } from "@/lib/api/agent-approval-route";
import { LEGACY_AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

export const maxDuration = 30;

export const POST = createAgentApprovalPost({
  endpoint: LEGACY_AGENT_API_ENDPOINT,
});
