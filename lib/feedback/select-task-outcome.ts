import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import type { PostHog } from "posthog-node";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "../db/convex-client";
import { taskOutcomeProperties } from "../analytics/task-outcome";
import {
  PAID_TASK_OUTCOME_FLAG,
  EXPERIMENT_TASK_OUTCOME_FLAG,
  experimentTaskOutcomePhase,
} from "./task-outcome";
import {
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
  type AbliteratedAssignment,
} from "../experiments/abliterated-model";

export async function selectTaskOutcomeSurvey(args: {
  posthog: Pick<PostHog, "getFeatureFlagResult" | "capture"> | null;
  userId: string;
  chatId: string;
  messageId: string;
  mode: "ask" | "agent";
  subscription: string;
  release?: string;
  assignment?: AbliteratedAssignment;
  selectedModelOverride?: string;
}) {
  const { posthog } = args;
  if (!posthog || !process.env.CONVEX_SERVICE_ROLE_KEY) return;
  const reportFailure = (stage: "flag" | "reserve" | "capture" | "link") => {
    console.warn(
      JSON.stringify({
        event: "task_outcome_survey_failed",
        stage,
        user_id: args.userId,
        chat_id: args.chatId,
        request_id: args.messageId,
        experiment_key: args.assignment?.key,
      }),
    );
  };
  let stage: "flag" | "reserve" = "flag";
  try {
    const paidEligible = ["pro", "pro-plus", "ultra"].includes(
      args.subscription,
    );
    const context = {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY,
      user_id: args.userId,
      chat_id: args.chatId,
      request_id: args.messageId,
      message_id: args.messageId,
      mode: args.mode,
      subscription_tier: args.subscription,
      release:
        args.release ||
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.GITHUB_SHA ||
        "unknown",
    };
    const selector = args.selectedModelOverride ?? "auto";
    const feedbackPhase = args.assignment
      ? experimentTaskOutcomePhase(args.assignment.key)
      : undefined;
    const experimentEligible =
      feedbackPhase !== undefined &&
      args.assignment !== undefined &&
      args.assignment.selectionSource ===
        (args.assignment.key === ABLITERATED_PAID_FIRST_STEP_KEY
          ? "paid_first_step"
          : "moderation") &&
      (args.assignment.key !== ABLITERATED_PAID_MODERATED_DEFAULT_KEY ||
        args.assignment.variant === "test") &&
      (args.assignment.variant === "control" ||
        args.assignment.variant === "test") &&
      ((args.assignment.key !== ABLITERATED_MAX_EXPERIMENT_KEY &&
        (selector === "hackerai-standard" || selector === "auto")) ||
        selector === "hackerai-pro" ||
        selector === "hackerai-max") &&
      ["pro", "pro-plus", "ultra", "team"].includes(args.subscription);
    // Never fall through to a different cohort for an assigned trial request.
    if (args.assignment && !experimentEligible) return;
    if (!experimentEligible && !paidEligible) return;
    if (
      (await getPostHogFlagWithoutExposure(
        posthog,
        experimentEligible
          ? EXPERIMENT_TASK_OUTCOME_FLAG
          : PAID_TASK_OUTCOME_FLAG,
        args.userId,
        { subscription_tier: args.subscription },
      )) !== true
    )
      return;
    stage = "reserve";
    const row =
      experimentEligible && args.assignment && feedbackPhase
        ? await getConvexClient().mutation(
            api.taskOutcomeSurveys.reserveExperiment,
            {
              ...context,
              survey_kind: "current_experiment",
              experiment_key: args.assignment.key as
                | typeof ABLITERATED_MAX_EXPERIMENT_KEY
                | typeof ABLITERATED_PAID_FIRST_STEP_KEY
                | typeof ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
              experiment_variant: args.assignment.variant,
              // Abliteration telemetry uses the original assistant ID as request ID.
              experiment_request_id: args.messageId,
              selected_model_override: selector as
                "auto" | "hackerai-standard" | "hackerai-pro" | "hackerai-max",
              assigned_model: args.assignment.modelKey,
              baseline_model: args.assignment.baselineModel,
              feedback_phase: feedbackPhase,
            },
          )
        : await getConvexClient().mutation(api.taskOutcomeSurveys.reserve, {
            ...context,
            survey_kind: "new_paid",
          });
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
      reportFailure("capture");
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
          reportFailure("link");
        }
      },
    };
  } catch {
    /* Selection failure keeps chat working and suppresses the survey. */
    reportFailure(stage);
  }
}
