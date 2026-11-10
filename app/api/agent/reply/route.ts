import { createAgentUserReplyPost } from "@/lib/api/agent-user-reply-route";
import { AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

export const maxDuration = 30;

export const POST = createAgentUserReplyPost({ endpoint: AGENT_API_ENDPOINT });
