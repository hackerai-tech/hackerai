import { v } from "convex/values";
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
export const scheduleDefinition = v.object({
  name: v.string(),
  prompt: v.string(),
  timing: scheduleTiming,
  model: scheduleModel,
});
export const scheduleRunStatus = v.union(
  v.literal("starting"),
  v.literal("started"),
  v.literal("finished"),
  v.literal("canceled"),
  v.literal("failed"),
  v.literal("skipped"),
);
