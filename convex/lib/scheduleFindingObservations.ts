import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./serviceFunctions";

export const MAX_SCHEDULE_OBSERVATIONS = 20;
// Rows are small. One mutation removes at most this many, then reports that
// more remain so its caller continues in a later transaction.
const OBSERVATION_DELETE_BATCH = 100;
// Scrubbing rewrites a full report per row, so that batch is much smaller.
const OBSERVATION_SCRUB_BATCH = 10;
const RUN_SUMMARY_LIMIT = 50;

type ScheduleOrigin = NonNullable<Doc<"chats">["schedule_origin"]>;
type WriteCtx = Pick<MutationCtx, "db">;

const sameScope = (
  finding: Pick<Doc<"findings">, "schedule_id" | "schedule_scope_key">,
  origin: ScheduleOrigin,
) =>
  finding.schedule_id === origin.scheduleId &&
  finding.schedule_scope_key === origin.scopeKey;

/** Schedule fields for a finding first saved by a scheduled task. */
export const scheduledFindingFields = (
  origin: ScheduleOrigin,
  chatId: string,
  messageId: string,
  observedAt: number,
) => ({
  schedule_id: origin.scheduleId,
  schedule_name: origin.scheduleName,
  schedule_scope_key: origin.scopeKey,
  schedule_observations: [
    {
      run_id: origin.runId,
      chat_id: chatId,
      message_id: messageId,
      observed_at: observedAt,
    },
  ],
  schedule_observation_count: 1,
});

/** The saving run's own occurrence row; call in the mutation that inserts the finding. */
export async function insertFirstScheduleObservation(
  ctx: WriteCtx,
  origin: ScheduleOrigin,
  finding: Pick<Doc<"findings">, "finding_id" | "user_id" | "chat_id">,
  observedAt: number,
) {
  await ctx.db.insert("schedule_finding_observations", {
    user_id: finding.user_id,
    finding_id: finding.finding_id,
    run_id: origin.runId,
    chat_id: finding.chat_id,
    observed_at: observedAt,
    first_report: true,
  });
}

/**
 * Records that this scheduled task's run reported an already saved finding.
 * The occurrence row decides whether the run is new, so a repeat is never
 * counted twice and a late first report is never dropped, regardless of which
 * runs the finding still retains for display. Returns whether it was counted.
 */
export async function recordScheduleObservation(
  ctx: WriteCtx,
  chat: Doc<"chats">,
  finding: Doc<"findings">,
  messageId: string,
  now: number,
): Promise<boolean> {
  const origin = chat.schedule_origin;
  if (
    !origin ||
    finding.user_id !== chat.user_id ||
    !sameScope(finding, origin)
  )
    return false;
  const recorded = await ctx.db
    .query("schedule_finding_observations")
    .withIndex("by_finding_and_run", (q) =>
      q.eq("finding_id", finding.finding_id).eq("run_id", origin.runId),
    )
    .unique();
  if (recorded) return false;
  await ctx.db.insert("schedule_finding_observations", {
    user_id: chat.user_id,
    finding_id: finding.finding_id,
    run_id: origin.runId,
    chat_id: chat.id,
    observed_at: now,
    first_report: false,
  });
  const retained = finding.schedule_observations ?? [];
  // The report itself is unchanged, so its revision (`updated_at`) is too.
  await ctx.db.patch(finding._id, {
    schedule_observations: [
      ...retained,
      {
        run_id: origin.runId,
        chat_id: chat.id,
        message_id: messageId,
        observed_at: now,
      },
    ].slice(-MAX_SCHEDULE_OBSERVATIONS),
    schedule_observation_count:
      (finding.schedule_observation_count ?? retained.length) + 1,
  });
  return true;
}

/** Summarize saved reports for a visible run without reading report bodies. */
export async function summarizeScheduleRunFindings(
  ctx: Pick<QueryCtx, "db">,
  run: Pick<Doc<"schedule_runs">, "_id" | "user_id" | "chat_id">,
) {
  const observations = await ctx.db
    .query("schedule_finding_observations")
    .withIndex("by_user_and_chat", (q) =>
      q.eq("user_id", run.user_id).eq("chat_id", run.chat_id),
    )
    .take(RUN_SUMMARY_LIMIT + 1);
  if (observations.length > RUN_SUMMARY_LIMIT) return undefined;

  let newCount = 0;
  let repeatCount = 0;
  for (const observation of observations) {
    if (
      observation.run_id !== run._id ||
      observation.first_report === undefined
    )
      return undefined;
    if (observation.first_report) newCount++;
    else repeatCount++;
  }
  return newCount + repeatCount ? { newCount, repeatCount } : undefined;
}

/**
 * Removes one bounded batch of a deleted finding's occurrence rows. Returns
 * true while rows remain.
 */
export async function deleteScheduleObservationsForFindingBatch(
  ctx: WriteCtx,
  findingId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("schedule_finding_observations")
    .withIndex("by_finding_and_run", (q) => q.eq("finding_id", findingId))
    .take(OBSERVATION_DELETE_BATCH + 1);
  for (const row of rows.slice(0, OBSERVATION_DELETE_BATCH))
    await ctx.db.delete(row._id);
  return rows.length > OBSERVATION_DELETE_BATCH;
}

/**
 * Removes one bounded batch of a deleted task's occurrence rows. A finding
 * saved by another task keeps its count and the run's time, but no longer
 * names the deleted task or its message. Returns true while rows remain.
 */
export async function deleteScheduleObservationsForChatBatch(
  ctx: WriteCtx,
  userId: string,
  chatId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("schedule_finding_observations")
    .withIndex("by_user_and_chat", (q) =>
      q.eq("user_id", userId).eq("chat_id", chatId),
    )
    .take(OBSERVATION_SCRUB_BATCH + 1);
  for (const row of rows.slice(0, OBSERVATION_SCRUB_BATCH)) {
    const finding = await ctx.db
      .query("findings")
      .withIndex("by_finding_id", (q) => q.eq("finding_id", row.finding_id))
      .unique();
    if (
      finding?.user_id === userId &&
      finding.schedule_observations?.some((entry) => entry.chat_id === chatId)
    )
      await ctx.db.patch(finding._id, {
        schedule_observations: finding.schedule_observations.map((entry) =>
          entry.chat_id === chatId
            ? { run_id: entry.run_id, observed_at: entry.observed_at }
            : entry,
        ),
      });
    await ctx.db.delete(row._id);
  }
  return rows.length > OBSERVATION_SCRUB_BATCH;
}
