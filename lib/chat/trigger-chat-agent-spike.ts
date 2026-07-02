export const TRIGGER_CHAT_AGENT_SPIKE_ENV = "HACKERAI_TRIGGER_CHAT_AGENT_SPIKE";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function isTriggerChatAgentSpikeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return ENABLED_VALUES.has(
    (env[TRIGGER_CHAT_AGENT_SPIKE_ENV] ?? "").trim().toLowerCase(),
  );
}
