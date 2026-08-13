import type { PostHog } from "posthog-node";

import type { AgentAutoReviewRolloutPhase } from "@/types";

export const AGENT_AUTO_REVIEW_FLAG_KEY = "agent_auto_review_v1";
export const AGENT_AUTO_REVIEW_EXPOSURE_EVENT = "agent_auto_review_exposed";
export const AGENT_AUTO_REVIEW_FEATURE_PROPERTY = `$feature/${AGENT_AUTO_REVIEW_FLAG_KEY}`;

export type AgentAutoReviewAssignment = {
  key: typeof AGENT_AUTO_REVIEW_FLAG_KEY;
  phase: AgentAutoReviewRolloutPhase;
};

type AgentAutoReviewEnvironment = {
  VERCEL_ENV?: string;
};

export function resolveAgentAutoReviewPreviewAssignment(
  environment: AgentAutoReviewEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
  },
): AgentAutoReviewAssignment | undefined {
  if (environment.VERCEL_ENV !== "preview") return undefined;
  return { key: AGENT_AUTO_REVIEW_FLAG_KEY, phase: "enforce" };
}

export async function evaluateAgentAutoReviewFlag({
  posthog,
  userId,
  captureExposure = false,
  surface = "agent_permission_selector",
}: {
  posthog: Pick<PostHog, "evaluateFlags" | "capture"> | null;
  userId: string;
  captureExposure?: boolean;
  surface?: "agent_permission_selector" | "agent_run";
}): Promise<AgentAutoReviewAssignment | undefined> {
  try {
    const previewAssignment = resolveAgentAutoReviewPreviewAssignment();
    if (previewAssignment) return previewAssignment;

    if (!posthog) return undefined;

    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [AGENT_AUTO_REVIEW_FLAG_KEY],
    });
    const phase = flags.getFlag(AGENT_AUTO_REVIEW_FLAG_KEY);
    if (phase !== "shadow" && phase !== "enforce") return undefined;

    const assignment: AgentAutoReviewAssignment = {
      key: AGENT_AUTO_REVIEW_FLAG_KEY,
      phase,
    };

    if (captureExposure) {
      posthog.capture({
        distinctId: userId,
        event: AGENT_AUTO_REVIEW_EXPOSURE_EVENT,
        properties: {
          rollout_phase: phase,
          surface,
          [AGENT_AUTO_REVIEW_FEATURE_PROPERTY]: phase,
          $process_person_profile: false,
        },
      });
    }

    return assignment;
  } catch (error) {
    console.warn("Agent Auto review flag evaluation failed", {
      event: "agent_auto_review_flag_evaluation_failed",
      flag_key: AGENT_AUTO_REVIEW_FLAG_KEY,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return undefined;
  }
}
