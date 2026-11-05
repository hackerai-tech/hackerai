import type { PostHog } from "posthog-node";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import { taskOutcomeProperties } from "@/lib/analytics/task-outcome";
import {
  AGENT_CONTEXT_FEEDBACK_FLAG,
  AGENT_CONTEXT_FEEDBACK_PHASE,
} from "./agent-context";

/** Called before variant-dependent history loading or any generation outcome.
 * Never reevaluate context assignment here or at answer time.
 */
export async function selectContextTaskOutcomeSurvey(args: {
  posthog: Pick<PostHog, "getFeatureFlagResult" | "capture"> | null;
  userId: string;
  chatId: string;
  messageId: string;
  triggerRunId: string;
  mode: "ask" | "agent";
  subscription: string;
  selectedModelOverride?: string;
  variant?: "control" | "test";
  release: string;
}) {
  const { posthog, variant, selectedModelOverride: selector } = args;
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (
    !posthog ||
    !serviceKey ||
    args.mode !== "agent" ||
    !variant ||
    !["pro", "pro-plus", "ultra", "team"].includes(args.subscription) ||
    (selector !== "hackerai-max" && selector !== "hackerai-pro")
  )
    return;
  const reportFailure = () =>
    console.warn(
      JSON.stringify({
        event: "context_feedback_selection_failed",
        request_id: args.triggerRunId,
      }),
    );
  try {
    if (
      (await getPostHogFlagWithoutExposure(
        posthog,
        AGENT_CONTEXT_FEEDBACK_FLAG,
        args.userId,
        {
          subscription_tier: args.subscription,
          mode: "agent",
          selected_model: selector,
        },
      )) !== true
    )
      return;
    const row = await getConvexClient().mutation(
      api.taskOutcomeSurveys.reserveContext,
      {
        serviceKey,
        user_id: args.userId,
        chat_id: args.chatId,
        request_id: args.messageId,
        message_id: args.messageId,
        trigger_run_id: args.triggerRunId,
        survey_kind: "agent_context",
        mode: "agent",
        subscription_tier: args.subscription,
        release: args.release,
        experiment_key:
          selector === "hackerai-max"
            ? "agent_model_context_v1"
            : "agent_pro_context_v1",
        experiment_variant: variant,
        selected_model_override: selector,
        feedback_phase: AGENT_CONTEXT_FEEDBACK_PHASE,
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
      reportFailure();
    }
    return {
      async linkMessage(messageId: string) {
        try {
          await getConvexClient().mutation(api.taskOutcomeSurveys.linkMessage, {
            serviceKey,
            user_id: args.userId,
            request_id: args.messageId,
            message_id: messageId,
          });
        } catch {
          reportFailure();
        }
      },
    };
  } catch {
    reportFailure();
  }
}
