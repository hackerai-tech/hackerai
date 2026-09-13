import type { AgentAutoReviewRolloutPhase } from "@/types";

export type AgentAutoReviewAssignment = {
  phase: AgentAutoReviewRolloutPhase;
};

export const DEFAULT_AGENT_AUTO_REVIEW_ASSIGNMENT = {
  phase: "enforce",
} as const satisfies AgentAutoReviewAssignment;
