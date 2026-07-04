export const CHAT_API_ENDPOINT = "/api/chat" as const;
export const AGENT_API_ENDPOINT = "/api/agent" as const;
export const AGENT_RESUME_ENDPOINT = "/api/agent/resume" as const;
export const AGENT_CANCEL_ENDPOINT = "/api/agent/cancel" as const;

export const LEGACY_AGENT_API_ENDPOINT = "/api/agent-long" as const;
export const LEGACY_AGENT_RESUME_ENDPOINT = "/api/agent-long/resume" as const;
export const LEGACY_AGENT_CANCEL_ENDPOINT = "/api/agent-long/cancel" as const;

// Keep the Trigger task id stable until old Vercel clients and Trigger deploys
// can no longer race against the renamed API route.
export const AGENT_TRIGGER_TASK_ID = "agent-long" as const;

export type AgentApiEndpoint =
  typeof AGENT_API_ENDPOINT | typeof LEGACY_AGENT_API_ENDPOINT;

export type ChatApiEndpoint = typeof CHAT_API_ENDPOINT | AgentApiEndpoint;
