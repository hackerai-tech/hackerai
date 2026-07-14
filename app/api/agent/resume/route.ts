import { createAgentResumeGet } from "@/lib/api/agent-resume-route";
import { AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

export const maxDuration = 30;

export const GET = createAgentResumeGet({
  endpoint: AGENT_API_ENDPOINT,
});
