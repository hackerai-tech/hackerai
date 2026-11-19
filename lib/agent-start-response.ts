/**
 * Marks the app's own Agent-start payload rejection so a client can tell it
 * from a 413 produced before the route ran. Absence does not prove the platform
 * rejected the request.
 */
export const AGENT_START_REJECTION_HEADER = "x-hackerai-agent-start-rejection";
export const AGENT_START_TRIGGER_PAYLOAD_TOO_LARGE =
  "trigger_payload_too_large";
