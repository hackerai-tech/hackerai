import { createAgentResumeGet } from "@/lib/api/agent-resume-route";
import { LEGACY_AGENT_API_ENDPOINT } from "@/lib/api/agent-endpoints";

export const maxDuration = 30;

export const GET = createAgentResumeGet({
  endpoint: LEGACY_AGENT_API_ENDPOINT,
});
