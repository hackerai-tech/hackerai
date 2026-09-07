import type { PostHog } from "posthog-node";
import type { AbliteratedAssignment } from "../experiments/abliterated-model";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "../db/convex-client";
import { taskOutcomeProperties } from "../analytics/task-outcome";
import { ABLITERATION_MAX_GENERATION_STEPS } from "../experiments/abliterated-model-steps";
import { TASK_OUTCOME_FLAG } from "./task-outcome";

export async function selectTaskOutcomeSurvey(args: {
  posthog: Pick<PostHog, "getFeatureFlag" | "capture"> | null;
  assignment?: AbliteratedAssignment;
  userId: string;
  chatId: string;
  messageId: string;
  mode: "ask" | "agent";
  subscription: string;
  release?: string;
}) {
  const { posthog, assignment } = args;
  if (!posthog || !assignment || !process.env.CONVEX_SERVICE_ROLE_KEY) return;
  try {
    const enabled = await posthog.getFeatureFlag(
      TASK_OUTCOME_FLAG,
      args.userId,
      {
        sendFeatureFlagEvents: false,
        personProperties: { subscription_tier: args.subscription },
      },
    );
    if (enabled !== true) return;
    const row = await getConvexClient().mutation(
      api.taskOutcomeSurveys.reserve,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY,
        user_id: args.userId,
        chat_id: args.chatId,
        request_id: args.messageId,
        message_id: args.messageId,
        experiment_variant: assignment.variant,
        baseline_model: assignment.baselineModel,
        assigned_model: assignment.modelKey,
        mode: args.mode,
        subscription_tier: args.subscription,
        routing_version: `generation_steps_${ABLITERATION_MAX_GENERATION_STEPS}_v1`,
        generation_step_limit: ABLITERATION_MAX_GENERATION_STEPS,
        release:
          args.release ||
          process.env.VERCEL_GIT_COMMIT_SHA ||
          process.env.GITHUB_SHA ||
          "unknown",
      },
    );
    if (!row) return;
    try {
      posthog.capture({
        distinctId: args.userId,
        event: "task_outcome_survey_selected",
        properties: {
          ...taskOutcomeProperties(row),
          $insert_id: `${row._id}:selected`,
        },
      });
    } catch {
      /* A capture failure must not lose fallback linkage. */
    }
    return {
      async linkMessage(messageId: string) {
        try {
          await getConvexClient().mutation(api.taskOutcomeSurveys.linkMessage, {
            serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
            user_id: args.userId,
            request_id: args.messageId,
            message_id: messageId,
          });
        } catch {
          /* Feedback must never prevent recovery. */
        }
      },
    };
  } catch {
    /* Selection failure keeps chat working and suppresses the survey. */
  }
}
