export const AGENT_RUN_SPEND_CAP_REASON = "agent_run_spend_cap" as const;
export const PRO_AGENT_RUN_SPEND_CAP_DOLLARS = 5;

export const AGENT_RUN_SPEND_CAP_BASES = ["fixed_5_dollars"] as const;

export type AgentRunSpendCapBasis = (typeof AGENT_RUN_SPEND_CAP_BASES)[number];

export interface AgentRunSpendCap {
  capDollars: number;
  basis: AgentRunSpendCapBasis;
}

export interface AgentRunSpendCapHit {
  runCostDollars: number;
  runCapDollars: number;
  monthlyRemainingDollars: number;
  capBasis: AgentRunSpendCapBasis;
}

export function isAgentRunSpendCapBasis(
  value: unknown,
): value is AgentRunSpendCapBasis {
  return (
    typeof value === "string" &&
    (AGENT_RUN_SPEND_CAP_BASES as readonly string[]).includes(value)
  );
}
