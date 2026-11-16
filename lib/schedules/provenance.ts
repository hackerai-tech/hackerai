import { createHash } from "node:crypto";
import type { Id } from "@/convex/_generated/dataModel";
import type { ScheduleDefinition } from "./recurrence";

/**
 * Provenance the scheduler attaches to a task it creates. It is built from the
 * claimed receipt on the worker and is never parsed from a request body.
 */
export type ScheduleOrigin = {
  scheduleId: Id<"agent_schedules">;
  scheduleName: string;
  runId: Id<"schedule_runs">;
  scopeKey: string;
};

/**
 * Identifies what a schedule assesses: its instructions, where it runs and the
 * model. Name, timing and enabled state are excluded, so renaming or
 * rescheduling keeps earlier findings comparable while new instructions start
 * a separate scope. A digest keeps the instructions out of identifiers.
 */
export function scheduleScopeKey(
  definition: Pick<ScheduleDefinition, "prompt" | "execution" | "model">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "schedule-scope-v1",
        definition.prompt,
        definition.execution?.preference ?? null,
        definition.execution?.workingDirectory ?? null,
        definition.model,
      ]),
    )
    .digest("hex");
}

export function createScheduleOrigin({
  scheduleId,
  runId,
  definition,
}: {
  scheduleId: Id<"agent_schedules">;
  runId: Id<"schedule_runs">;
  definition: ScheduleDefinition;
}): ScheduleOrigin {
  return {
    scheduleId,
    scheduleName: definition.name,
    runId,
    scopeKey: scheduleScopeKey(definition),
  };
}
