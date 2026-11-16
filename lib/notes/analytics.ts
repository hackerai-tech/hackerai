import { phLogger } from "@/lib/posthog/server";
import { RECALL_TOKEN_BUDGET } from "./policy";
import type { RelevantNotesSection } from "./recall";

/** Rollout flag that every Notes recall event is attributed to. */
export const NOTES_RELEVANT_RECALL_FLAG = "notes_relevant_recall_v1";

/** Inclusion probability of routine successful Notes diagnostics. */
const ROUTINE_SAMPLE_RATE = 0.05;

/**
 * Notes events carry only the existing user identity, closed outcomes,
 * counts, durations and booleans: never task text, targets, note IDs,
 * cursors, content or error messages. Routine successes are sampled before
 * capture; errors, timeouts and budget violations are always captured.
 * `sample_rate` is the event's inclusion probability, so counts can be
 * reweighted. Telemetry failures are swallowed so they can never change a
 * lookup or tool result.
 */
function captureNotesEvent(
  name: string,
  userId: string,
  isRoutine: () => boolean,
  properties: () => Record<string, number | boolean | string>,
): void {
  try {
    const sampleRate = isRoutine() ? ROUTINE_SAMPLE_RATE : 1;
    if (sampleRate < 1 && !(Math.random() < sampleRate)) return;
    phLogger.event(name, {
      userId,
      feature_flag: NOTES_RELEVANT_RECALL_FLAG,
      ...properties(),
      sample_rate: sampleRate,
    });
  } catch {
    // best-effort
  }
}

/** A block above the shared budget is a violation, never a routine event. */
const withinBudget = (result: RelevantNotesSection) =>
  result.tokenCount <= RECALL_TOKEN_BUDGET;

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
  captureNotesEvent(
    "notes_recall_exposed",
    userId,
    () => withinBudget(result),
    () => sectionCounts(result),
  );
}

export type RelevantRecallOutcome = "hit" | "no_match" | "timeout" | "error";

/**
 * At most one event per relevant-notes lookup, initial injection and
 * post-mutation refreshes alike, so its hit rate is per lookup rather than
 * per user request. Whether a block was actually injected is the exposure event.
 * Failures have no counts.
 */
export function recordRelevantRecallResult(
  userId: string,
  startedAt: number,
  result: RelevantNotesSection | "timeout" | "error",
): void {
  captureNotesEvent(
    "notes_recall_result",
    userId,
    () => typeof result !== "string" && withinBudget(result),
    () => {
      const duration_ms = elapsedMs(startedAt);
      if (typeof result === "string") return { outcome: result, duration_ms };
      const outcome: RelevantRecallOutcome = result.section
        ? "hit"
        : "no_match";
      return { outcome, duration_ms, ...sectionCounts(result) };
    },
  );
}

export type NoteReadResult =
  | { outcome: "success"; continuation: boolean; hasMore: boolean }
  | { outcome: "error"; continuation: boolean };

/** At most one event per executed get_note call; history replay never executes. */
export function recordNoteReadResult(
  userId: string,
  startedAt: number,
  read: NoteReadResult,
): void {
  captureNotesEvent(
    "notes_read_result",
    userId,
    () => read.outcome === "success",
    () => ({
      outcome: read.outcome,
      duration_ms: elapsedMs(startedAt),
      continuation: read.continuation,
      ...(read.outcome === "success" && { has_more: read.hasMore }),
    }),
  );
}
