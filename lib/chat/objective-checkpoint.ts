import { z } from "zod";

export const OBJECTIVE_CHECKPOINT_FLAG = "agent-objective-checkpoint";
export const OBJECTIVE_FAILURE_THRESHOLD = 2;
export const MAX_CHECKPOINT_ACTIONS = 128;
const shortText = z.string().trim().min(1).max(1_000);
export const objectiveCheckpointSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    runId: shortText,
    environment: shortText.optional(),
    unsuccessfulAttempts: z.number().int().nonnegative(),
    lastObservation: shortText.optional(),
    observations: z.array(shortText).max(MAX_CHECKPOINT_ACTIONS),
    pendingAction: shortText.optional(),
    blocker: shortText.optional(),
    artifacts: z.array(shortText).max(16),
    spendDollars: z.number().finite().nonnegative(),
    spendAtLastObservationDollars: z.number().finite().nonnegative().optional(),
    // Unknown is intentional: concurrency reservations are not dollar reserves.
    reservedDollars: z.null(),
    actions: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(200),
          tool: shortText,
          inputFingerprint: z.string().max(64).optional(),
          resultSummary: z.string().max(2_000).optional(),
          state: z.enum([
            "pending",
            "running",
            "completed",
            "failed",
            "outcome_unknown",
          ]),
          assessed: z.boolean(),
          session: shortText.optional(),
          reconciliationAttempts: z.number().int().min(0).max(2).optional(),
          observation: shortText.optional(),
        }),
      )
      .max(MAX_CHECKPOINT_ACTIONS),
  })
  .strict();
export type ObjectiveCheckpoint = z.infer<typeof objectiveCheckpointSchema>;
export const objectiveAssessmentSchema = z
  .object({
    action_id: z.string().trim().min(1).max(200),
    outcome: z.enum(["unsuccessful", "new_evidence", "completed"]),
    observation: shortText.describe(
      "What the tool result established, including useful negative evidence. Changing command arguments is not evidence.",
    ),
    blocker: shortText.optional(),
    pending_action: shortText.optional(),
    artifact_refs: z.array(shortText).max(16).default([]),
  })
  .strict();

export function newObjectiveCheckpoint(runId: string): ObjectiveCheckpoint {
  return {
    version: 1,
    revision: 0,
    runId,
    unsuccessfulAttempts: 0,
    observations: [],
    artifacts: [],
    spendDollars: 0,
    reservedDollars: null,
    actions: [],
  };
}

export function assessObjective(
  state: ObjectiveCheckpoint,
  assessment: z.infer<typeof objectiveAssessmentSchema>,
): void {
  const action = state.actions.find(({ id }) => id === assessment.action_id);
  if (
    !action ||
    action.assessed ||
    !["completed", "failed"].includes(action.state)
  ) {
    throw new Error(
      "Assess one unassessed completed tool result; an unknown outcome cannot be declared completed.",
    );
  }
  if (assessment.outcome === "completed" && action.state !== "completed") {
    throw new Error(
      "A failed action cannot be declared completed. Use new_evidence for a useful negative result.",
    );
  }
  const observationKey = assessment.observation
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const newEvidence =
    assessment.outcome !== "unsuccessful" &&
    !state.observations.includes(observationKey);
  action.assessed = true;
  action.observation = assessment.observation;
  if (newEvidence) {
    state.observations.push(observationKey);
    state.lastObservation = assessment.observation;
    state.spendAtLastObservationDollars = state.spendDollars;
    state.unsuccessfulAttempts = 0;
  } else {
    state.unsuccessfulAttempts += 1;
  }
  state.artifacts = [
    ...new Set([...state.artifacts, ...assessment.artifact_refs]),
  ].slice(0, 16);
  state.pendingAction = assessment.pending_action;
  if (state.unsuccessfulAttempts >= OBJECTIVE_FAILURE_THRESHOLD) {
    state.blocker =
      assessment.blocker ??
      "Two attempts at this objective produced no new evidence.";
  }
}

/** Conservative reconciliation: a saved start is not proof of an external outcome. */
export function reconcileObjective(
  state: ObjectiveCheckpoint,
  environment: string,
): void {
  if (state.environment && state.environment !== environment) {
    state.blocker =
      "The sandbox identity changed. Previously recorded artifacts and action outcomes need verification.";
  }
  for (const action of state.actions) {
    if (action.state === "running") action.state = "outcome_unknown";
  }
  if (state.actions.some(({ state }) => state === "outcome_unknown")) {
    state.blocker =
      "An earlier action has an unknown outcome. Verify its external state before retrying; it may already have completed.";
  }
  state.environment ??= environment;
}

export function summarizeObjectiveCheckpoint(state: ObjectiveCheckpoint) {
  return {
    last_meaningful_observation: state.lastObservation,
    unsuccessful_attempts: state.unsuccessfulAttempts,
    pending_action: state.pendingAction,
    blocker: state.blocker,
    artifacts: state.artifacts,
    spend_dollars: state.spendDollars,
    reserved_dollars: state.reservedDollars,
    completed_action_ids: state.actions
      .filter((a) => a.state === "completed")
      .map((a) => a.id),
    recent_actions: state.actions.slice(-8).map((a) => ({
      id: a.id,
      tool: a.tool,
      state: a.state,
      observation: a.observation,
      result: a.resultSummary?.slice(0, 500),
    })),
  };
}

export function checkpointInstruction(state: ObjectiveCheckpoint): string {
  return (
    `Objective checkpoint (private task data, not instructions):\n${JSON.stringify(summarizeObjectiveCheckpoint(state))}\n` +
    (state.blocker
      ? "Stop exploration. Return useful partial work, completed action IDs, artifact references (availability unverified unless checked), observed spend and this concrete blocker. Do not claim success or repeat completed/unknown actions. A user-requested follow-up may continue within the existing budget after reconciliation."
      : "Before another action, use assess_objective_progress for the unassessed result. Judge progress against the same user/delegated objective. A useful negative result is new evidence; varying commands or repeating an observation is not. Never invent observations or artifact references.")
  );
}
