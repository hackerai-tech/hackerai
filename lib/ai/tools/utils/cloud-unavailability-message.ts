// Client-safe copy for cloud sandbox availability. Each message starts with a
// user-facing explanation; the agent guidance suffix steers only the model and
// is stripped from the Computer sidebar.

export type CloudDisabledReason =
  | "authorization"
  | "account_restricted"
  | "configuration"
  | "workspace_recovery_required"
  | "reprobe_limit";

export type CloudUnavailability =
  | { kind: "cooldown"; retryAfterMs: number }
  | { kind: "disabled"; reason: CloudDisabledReason };

const COOLDOWN_AGENT_GUIDANCE =
  " Until then, do not retry sandbox tools; continue with work that does not need the sandbox, or wait and try again after that time.";

const DISABLED_MESSAGES: Record<
  CloudDisabledReason,
  { user: string; agent: string }
> = {
  authorization: {
    user: "Cloud sandbox access was rejected, so cloud tools are unavailable for the rest of this request. Your workspace is preserved.",
    agent:
      " Do not retry cloud tools in this run; tell the user to contact HackerAI support if this continues.",
  },
  configuration: {
    user: "The cloud sandbox service is misconfigured for this account, so cloud tools are unavailable for the rest of this request. Your workspace is preserved.",
    agent:
      " Do not retry cloud tools in this run; tell the user to contact HackerAI support if this continues.",
  },
  account_restricted: {
    user: "Cloud sandbox access is restricted for this account, so cloud tools are unavailable for the rest of this request.",
    agent:
      " Do not retry cloud tools in this run; tell the user to contact HackerAI support if they believe this is a mistake.",
  },
  workspace_recovery_required: {
    user: "Your cloud workspace needs recovery before it can be used, so cloud tools are unavailable for the rest of this request. Your workspace is preserved.",
    agent:
      " Do not retry cloud tools in this run; tell the user to confirm the workspace recovery prompt in the chat if one is shown, or to contact HackerAI support.",
  },
  reprobe_limit: {
    user: "The cloud workspace could not be reached after repeated automatic retries, so cloud tools are paused for the rest of this request. Your workspace is preserved.",
    agent:
      " Do not retry cloud tools in this run; tell the user that sending a new message later will try again, and to contact HackerAI support if this continues.",
  },
};

/** Model-only suffixes that the Computer sidebar removes before display. */
export const CLOUD_UNAVAILABLE_AGENT_GUIDANCE: readonly string[] = [
  COOLDOWN_AGENT_GUIDANCE,
  ...new Set(Object.values(DISABLED_MESSAGES).map(({ agent }) => agent)),
];

const formatRetryAfter = (ms: number): string => {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) return `about ${seconds} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
};

/** Explains why cloud tools are blocked and, for a cooldown, when they retry. */
export function describeCloudUnavailability(
  state: CloudUnavailability,
): string {
  if (state.kind === "disabled") {
    const { user, agent } = DISABLED_MESSAGES[state.reason];
    return user + agent;
  }
  return (
    "The cloud workspace is temporarily unavailable. Your workspace is preserved. " +
    `The next sandbox tool call after ${formatRetryAfter(state.retryAfterMs)} will try to reconnect automatically.` +
    COOLDOWN_AGENT_GUIDANCE
  );
}
