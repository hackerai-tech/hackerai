import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "./serviceFunctions";
import { FINDING_DEDUPE_LIMIT } from "../../lib/findings/dedupe-context";

export const SCHEDULE_FINDING_COUNT_CAP = 100;
// Within one project, a dedupe key repeats only while a source task is being
// deleted or moved. Both the row and byte bounds are far above that.
const SCOPE_DUPLICATE_ROWS = 10;
const SCOPE_READ_BYTES = 2_000_000;

type ReadCtx = Pick<QueryCtx, "db">;
export type ScheduleOrigin = NonNullable<Doc<"chats">["schedule_origin"]>;

const getChat = (ctx: ReadCtx, chatId: string) =>
  ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .unique();

/**
 * Accepts scheduler-supplied provenance only when its receipt names this
 * owner, task and schedule. A receipt removed with its schedule leaves an
 * ordinary task, so deleting a schedule mid-dispatch starts exactly as before.
 */
export async function verifyScheduleOrigin(
  ctx: ReadCtx,
  {
    chatId,
    userId,
    origin,
  }: {
    chatId: string;
    userId: string;
    origin: ScheduleOrigin;
  },
): Promise<ScheduleOrigin | null> {
  const receipt = await ctx.db.get(origin.runId);
  if (!receipt) return null;
  if (
    receipt.user_id !== userId ||
    receipt.chat_id !== chatId ||
    receipt.schedule_id !== origin.scheduleId ||
    !/^[a-f0-9]{64}$/.test(origin.scopeKey) ||
    !origin.scheduleName ||
    origin.scheduleName.length > 80
  ) {
    throw new ConvexError({
      code: "SCHEDULE_ORIGIN_MISMATCH",
      message: "Schedule provenance does not match this task",
      operation: "chats.saveChat",
    });
  }
  return {
    scheduleId: origin.scheduleId,
    scheduleName: origin.scheduleName,
    runId: origin.runId,
    scopeKey: origin.scopeKey,
  };
}

/**
 * The task a finding may be read or corrected from. A task always reaches its
 * own findings. A scheduled task also reaches findings saved by earlier runs
 * of the same schedule and scope, while their source task is still owned,
 * readable and in the same project. Returns that source task, or null.
 */
export async function findingSourceForChat(
  ctx: ReadCtx,
  chat: Doc<"chats">,
  finding: Doc<"findings">,
  sources = new Map<string, Doc<"chats"> | null>(),
): Promise<Doc<"chats"> | null> {
  if (finding.user_id !== chat.user_id) return null;
  if (finding.chat_id === chat.id) return chat;
  const origin = chat.schedule_origin;
  if (
    !origin ||
    finding.schedule_id !== origin.scheduleId ||
    finding.schedule_scope_key !== origin.scopeKey ||
    finding.project_id !== chat.project_id
  )
    return null;
  if (!sources.has(finding.chat_id))
    sources.set(finding.chat_id, await getChat(ctx, finding.chat_id));
  const source = sources.get(finding.chat_id);
  return source &&
    source.user_id === chat.user_id &&
    !source.deletion_started_at &&
    source.project_id === chat.project_id
    ? source
    : null;
}

/**
 * Earliest saved finding with this dedupe key that the scheduled task shares.
 * The read is bounded and limited to the task's project. `unresolved` means
 * the bound was reached with only unavailable copies (their source task is
 * being deleted or moved), so a shared finding may exist beyond it: the caller
 * must not save or change anything until those copies are gone.
 */
export async function findScheduleScopeDuplicate(
  ctx: ReadCtx,
  chat: Doc<"chats">,
  origin: ScheduleOrigin,
  dedupeKey: string,
  except?: Id<"findings">,
): Promise<{ finding: Doc<"findings"> | null; unresolved: boolean }> {
  const { page, isDone } = await ctx.db
    .query("findings")
    .withIndex("by_user_schedule_scope_project_dedupe", (q) =>
      q
        .eq("user_id", chat.user_id)
        .eq("schedule_id", origin.scheduleId)
        .eq("schedule_scope_key", origin.scopeKey)
        .eq("project_id", chat.project_id)
        .eq("dedupe_key", dedupeKey),
    )
    .paginate({
      numItems: SCOPE_DUPLICATE_ROWS,
      cursor: null,
      maximumBytesRead: SCOPE_READ_BYTES,
    });
  const sources = new Map<string, Doc<"chats"> | null>();
  for (const finding of page)
    if (
      finding._id !== except &&
      (await findingSourceForChat(ctx, chat, finding, sources))
    )
      return { finding, unresolved: false };
  return { finding: null, unresolved: !isDone };
}

/** Newest findings the scheduled task shares, for semantic comparison. */
export async function recentScheduleScopeFindings(
  ctx: ReadCtx,
  chat: Doc<"chats">,
  origin: ScheduleOrigin,
): Promise<Doc<"findings">[]> {
  const { page } = await ctx.db
    .query("findings")
    .withIndex("by_user_schedule_scope_project_created", (q) =>
      q
        .eq("user_id", chat.user_id)
        .eq("schedule_id", origin.scheduleId)
        .eq("schedule_scope_key", origin.scopeKey)
        .eq("project_id", chat.project_id),
    )
    .order("desc")
    .paginate({
      numItems: FINDING_DEDUPE_LIMIT,
      cursor: null,
      maximumBytesRead: SCOPE_READ_BYTES,
    });
  const sources = new Map<string, Doc<"chats"> | null>();
  const shared: Doc<"findings">[] = [];
  for (const finding of page)
    if (await findingSourceForChat(ctx, chat, finding, sources))
      shared.push(finding);
  return shared;
}

/**
 * Saved findings from a schedule's tasks, capped for display. Counts compact
 * per-task source rows instead of reading reports, and skips tasks that are
 * gone, reassigned or being deleted. "More than the cap" is reported only when
 * that many readable findings were counted. If the bounded read is full of
 * skipped tasks, the true count is unknown and none is shown until cleanup
 * finishes.
 */
export async function countScheduleFindings(
  ctx: ReadCtx,
  userId: string,
  scheduleId: Id<"agent_schedules">,
): Promise<{ findingCount: number; findingCountTruncated: boolean }> {
  const sources = await ctx.db
    .query("finding_sources")
    .withIndex("by_user_schedule", (q) =>
      q.eq("user_id", userId).eq("schedule_id", scheduleId),
    )
    .take(SCHEDULE_FINDING_COUNT_CAP + 1);
  let count = 0;
  for (const source of sources) {
    const chat = await getChat(ctx, source.chat_id);
    if (!chat || chat.user_id !== userId || chat.deletion_started_at) continue;
    count += source.finding_count;
    if (count > SCHEDULE_FINDING_COUNT_CAP) break;
  }
  if (count > SCHEDULE_FINDING_COUNT_CAP)
    return {
      findingCount: SCHEDULE_FINDING_COUNT_CAP,
      findingCountTruncated: true,
    };
  // A full read that stayed under the cap skipped some tasks, and readable
  // ones may lie beyond it.
  if (sources.length > SCHEDULE_FINDING_COUNT_CAP)
    return { findingCount: 0, findingCountTruncated: false };
  return { findingCount: count, findingCountTruncated: false };
}
