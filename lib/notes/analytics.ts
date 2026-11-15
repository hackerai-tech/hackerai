import { phLogger } from "@/lib/posthog/server";
import type { RelevantNotesSection } from "./recall";

/** Rollout flag that every Notes recall event is attributed to. */
export const NOTES_RELEVANT_RECALL_FLAG = "notes_relevant_recall_v1";

/**
 * Notes events carry only the existing user identity, closed outcomes,
 * counts, durations and booleans: never task text, targets, note IDs,
 * cursors, content or error messages. Telemetry failures are swallowed so
 * they can never change a lookup or tool result.
 */
function captureNotesEvent(
  name: string,
  userId: string,
  properties: () => Record<string, number | boolean | string>,
): void {
  try {
    phLogger.event(name, {
      userId,
      feature_flag: NOTES_RELEVANT_RECALL_FLAG,
      ...properties(),
    });
  } catch {
    // best-effort
  }
}

const elapsedMs = (startedAt: number) =>
  Math.max(0, Math.round(Date.now() - startedAt));

const sectionCounts = (result: RelevantNotesSection) => ({
  note_count: result.noteCount,
  targeted_note_count: result.targetedCount,
  candidate_count: result.candidateCount,
  token_count: result.tokenCount,
  recheck_due_count: result.recheckDueCount,
  observation_date_unknown_count: result.observationDateUnknownCount,
});

/** Exposure means a non-empty block actually reached the model: counts only. */
export function recordRelevantRecallExposure(
  userId: string,
  result: RelevantNotesSection,
): void {
  if (!result.section) return;
  captureNotesEvent("notes_recall_exposed", userId, () =>
    sectionCounts(result),
  );
}

export type RelevantRecallOutcome = "hit" | "no_match" | "timeout" | "error";

/**
 * One event per relevant-notes lookup, initial injection and post-mutation
 * refreshes alike, so its hit rate is per lookup rather than per user
 * request. Whether a block was actually injected is the exposure event.
 * Failures have no counts.
 */
export function recordRelevantRecallResult(
  userId: string,
  startedAt: number,
  result: RelevantNotesSection | "timeout" | "error",
): void {
  captureNotesEvent("notes_recall_result", userId, () => {
    const duration_ms = elapsedMs(startedAt);
    if (typeof result === "string") return { outcome: result, duration_ms };
    const outcome: RelevantRecallOutcome = result.section ? "hit" : "no_match";
    return { outcome, duration_ms, ...sectionCounts(result) };
  });
}

export type NoteReadResult =
  | { outcome: "success"; continuation: boolean; hasMore: boolean }
  | { outcome: "error"; continuation: boolean };

/** One event per executed get_note call; history replay never executes. */
export function recordNoteReadResult(
  userId: string,
  startedAt: number,
  read: NoteReadResult,
): void {
  captureNotesEvent("notes_read_result", userId, () => ({
    outcome: read.outcome,
    duration_ms: elapsedMs(startedAt),
    continuation: read.continuation,
    ...(read.outcome === "success" && { has_more: read.hasMore }),
  }));
}
