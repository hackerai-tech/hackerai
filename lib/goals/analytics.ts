import { v5 as uuidv5 } from "uuid";
import PostHogClient from "@/app/posthog";
import type { Doc } from "@/convex/_generated/dataModel";
import { goalElapsedMs } from "./timing";
import { isDesktopPreference } from "@/lib/sandbox/environment";

export type GoalLifecycleAction =
  | "admitted"
  | "resumed"
  | "run_started"
  | "settled"
  | "reconciled"
  | "pause"
  | "stop"
  | "clear"
  | "update"
  | "dispatch_scheduled"
  | "dispatch_started"
  | "dispatch_failed"
  | "schedule_failed"
  | "admission_failed";

type GoalAnalyticsContext = {
  userId: string;
  chatId: string;
  goalGeneration?: number;
  subscription?: string;
  runId?: string;
  workerVersion?: string;
  automatic?: boolean;
};

/** Allowlisted snapshots only. Telemetry must never change goal execution. */
export async function captureGoalLifecycle(
  action: GoalLifecycleAction,
  context: GoalAnalyticsContext,
  goal?: Doc<"agent_goals"> | null,
) {
  let client: ReturnType<typeof PostHogClient> = null;
  try {
    client = PostHogClient();
    if (!client) return;
    const attempt = goal
      ? `${goal._id}:${goal.startedAt ?? goal._creationTime}`
      : undefined;
    const generation = goal?.generation ?? context.goalGeneration;
    const properties = {
      telemetry_version: 1,
      action,
      goal_id: goal?._id,
      goal_attempt_id: attempt,
      goal_generation: generation,
      chat_id: context.chatId,
      trigger_run_id: context.runId,
      state: goal?.state,
      snapshot_updated_at: goal?.updatedAt,
      deleted: goal ? !!goal.deletedAt : undefined,
      wait_until: goal?.waitUntil,
      runs_used: goal?.runs,
      criteria_count: goal?.criteria.length,
      verified_criteria_count: goal
        ? new Set(goal.evidence.map((e) => e.criterion)).size
        : undefined,
      evidence_count: goal?.evidence.length,
      no_progress_runs: goal?.noProgressRuns,
      elapsed_ms: goal ? goalElapsedMs(goal, Date.now()) : undefined,
      has_verification_command: goal ? !!goal.verificationCommand : undefined,
      sandbox_type: goal
        ? goal.sandboxPreference === "e2b"
          ? "cloud"
          : isDesktopPreference(goal.sandboxPreference)
            ? "desktop"
            : "local"
        : undefined,
      permission_mode: goal?.permissionMode,
      subscription: context.subscription,
      automatic_continuation: context.automatic,
      worker_version: context.workerVersion,
      service_version:
        process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA,
      $geoip_disable: true,
      $process_person_profile: false,
    };
    client.capture({
      distinctId: context.userId,
      event: "agent_goal_lifecycle",
      uuid: uuidv5(
        JSON.stringify([
          attempt ?? context.chatId,
          generation,
          action,
          context.runId ?? goal?.updatedAt,
        ]),
        uuidv5.URL,
      ),
      properties,
    });
  } catch {
    console.warn("Goal analytics capture failed", {
      action,
      chat_id: context.chatId,
    });
  } finally {
    // Bound delivery so an analytics outage cannot hold up a goal or cancellation.
    try {
      await client?.shutdown(1000);
    } catch {
      // Both synchronous SDK errors and rejected delivery are non-fatal.
    }
  }
}
