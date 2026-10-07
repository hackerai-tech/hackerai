import { z } from "zod";

// Validate checkpoint records written by older workers during deployment overlap.
const MAX_CHECKPOINT_ACTIONS = 128;
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

/** Creates a version-1 record for compatibility tests and older worker writes. */
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
