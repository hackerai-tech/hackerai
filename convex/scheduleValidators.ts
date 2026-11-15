import { v } from "convex/values";
import { findingRevisionValidator } from "./findingValidators";
/** Trusted snapshot of the schedule and receipt that created a task. */
export const scheduleOrigin = v.object({
  scheduleId: v.id("agent_schedules"),
  scheduleName: v.string(),
  runId: v.id("schedule_runs"),
  scopeKey: v.string(),
});
/**
 * One run of a schedule that reported a saved finding, as retained on the
 * finding for display. The task and message are removed when that task is
 * deleted; the run and its time remain.
 */
export const scheduleObservation = v.object({
  run_id: v.id("schedule_runs"),
  chat_id: v.optional(v.string()),
  message_id: v.optional(v.string()),
  observed_at: v.number(),
});
/** A correction from a later run names that run's task; the original source stays unchanged. */
export const scheduledFindingRevision = v.object({
  ...findingRevisionValidator.fields,
  chat_id: v.optional(v.string()),
});
export const scheduleTiming = v.union(
  v.object({ type: v.literal("once"), at: v.number() }),
  v.object({ type: v.literal("interval"), minutes: v.number() }),
  v.object({
    type: v.literal("weekly"),
    time: v.string(),
    weekdays: v.array(v.number()),
    timezone: v.string(),
  }),
);
export const scheduleModel = v.union(
  v.literal("default"),
  v.literal("pro"),
  v.literal("max"),
);
export const localScheduleExecution = v.object({
  type: v.literal("local"),
  preference: v.string(),
  name: v.string(),
  workingDirectory: v.string(),
});
export const scheduleDefinition = v.object({
  execution: v.optional(localScheduleExecution),
  name: v.string(),
  prompt: v.string(),
  timing: scheduleTiming,
  model: scheduleModel,
});
export const scheduleRunStatus = v.union(
  v.literal("queued"),
  v.literal("uncertain_start"),
  v.literal("unconfirmed"),
  v.literal("starting"),
  v.literal("started"),
  v.literal("finished"),
  v.literal("canceled"),
  v.literal("failed"),
  v.literal("skipped"),
);
