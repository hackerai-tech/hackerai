/**
 * Client-safe contract for the free Agent activation experiment (HAC-246).
 * Server eligibility, flag evaluation and counting live in
 * `free-agent-activation.server.ts`; nothing here may carry server data.
 */
export const FREE_AGENT_ACTIVATION_KEY = "free_agent_activation_gate_v1";

/** Lifetime successfully persisted Ask responses before Ask is gated. */
export const FREE_AGENT_ASK_INTRO_LIMIT = 3;

/** Bump when eligibility or counting semantics change for analytics readouts. */
export const FREE_AGENT_ACTIVATION_DEFINITION_VERSION = 1;

/** Denial metadata key set on the Ask admission error. */
export const FREE_AGENT_ACTIVATION_REQUIRED_METADATA =
  "free_agent_activation_required";

export type FreeAgentActivationVariant = "control" | "test";

export type FreeAgentActivationStatus = {
  variant: FreeAgentActivationVariant;
  completedAskResponses: number;
  introLimit: number;
  requiresAgent: boolean;
};

export function createFreeAgentActivationStatus(
  variant: FreeAgentActivationVariant,
  completedAskResponses: number,
): FreeAgentActivationStatus {
  const completed = Math.min(
    FREE_AGENT_ASK_INTRO_LIMIT,
    Math.max(0, Math.trunc(completedAskResponses)),
  );
  return {
    variant,
    completedAskResponses: completed,
    introLimit: FREE_AGENT_ASK_INTRO_LIMIT,
    requiresAgent:
      variant === "test" && completed >= FREE_AGENT_ASK_INTRO_LIMIT,
  };
}

/** Lets a stale tab recognize the server's Ask denial and refresh status. */
export function isFreeAgentActivationRequiredMetadata(
  metadata: unknown,
): boolean {
  return (
    !!metadata &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>)[
      FREE_AGENT_ACTIVATION_REQUIRED_METADATA
    ] === true
  );
}
