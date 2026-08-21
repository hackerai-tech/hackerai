export const SUBAGENT_PARENT_DELIVERY_CLAIM_TTL_MS = 30_000;
export const SUBAGENT_PARENT_GATE_EXTRA_STEPS = 3;

export type SubagentDeliveryClaim = {
  subagent_id: string;
  claim_id: string;
};

export type SubagentParentCompletionState = {
  activeCount: number;
  unconsumedSubagentIds: string[];
};

export type SubagentParentCompletionGate = {
  getState: () => Promise<SubagentParentCompletionState>;
  markInjected: (claims: SubagentDeliveryClaim[]) => Promise<void>;
  markConsumed: (claims: SubagentDeliveryClaim[]) => Promise<void>;
  onBlocked?: (state: SubagentParentCompletionState) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const extractSubagentDeliveryClaims = (
  toolResults: readonly unknown[],
): SubagentDeliveryClaim[] => {
  const claims = new Map<string, SubagentDeliveryClaim>();

  for (const toolResult of toolResults) {
    if (!isRecord(toolResult)) continue;
    if (toolResult.toolName !== "wait_for_agents") continue;
    const output = isRecord(toolResult.output)
      ? toolResult.output
      : isRecord(toolResult.result)
        ? toolResult.result
        : null;
    if (!output || !isRecord(output._delivery_claim)) continue;
    const subagentId = output._delivery_claim.subagent_id;
    const claimId = output._delivery_claim.claim_id;
    if (typeof subagentId !== "string" || typeof claimId !== "string") {
      continue;
    }
    claims.set(`${subagentId}:${claimId}`, {
      subagent_id: subagentId,
      claim_id: claimId,
    });
  }

  return [...claims.values()];
};

export const requiresSubagentParentGate = (
  state: SubagentParentCompletionState,
  claimsBeingInjected: readonly SubagentDeliveryClaim[] = [],
): boolean => {
  const injectingIds = new Set(
    claimsBeingInjected.map((claim) => claim.subagent_id),
  );
  return (
    state.activeCount > 0 ||
    state.unconsumedSubagentIds.some((id) => !injectingIds.has(id))
  );
};
