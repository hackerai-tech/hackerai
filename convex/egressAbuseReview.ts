import { getDocumentSize, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./lib/serviceFunctions";
import { boundedAbuseCiphertext } from "./lib/abuseResponse";
import { isUserDeletionFenced } from "./lib/userDeletionFence";

// Read-only evidence lookups and a create-or-preserve case write for the
// automated egress burst review. Authorized only by the dedicated review key,
// which serviceFunctions scopes to this module. Nothing here reads beyond one
// linked chat and run, searches a user's chats, or creates a notice or
// restriction.

const ACTOR = "egress_abuse_review";
const MAX_SCAN = 120;
// One query shares a transaction read budget; a document can overshoot this
// threshold by at most its own size.
const MAX_SCAN_BYTES = 6 * 1024 * 1024;
const MAX_USER_MESSAGES = 30;
const MAX_COMMANDS = 80;
const MAX_TEXT_CHARS = 4_000;
const MAX_SUBAGENT_SCAN = 50;
const MAX_ACTIVE_ROOTS = 5;
const MAX_BURST_SPAN_MS = 10 * 60_000;
/** Persisted run timing comes from other hosts' clocks. */
const CLOCK_SKEW_MS = 60_000;
const REFERENCE =
  /^AB-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ACTIVE_SUBAGENT = new Set(["queued", "running", "finalizing"]);

function authorize(serviceKey: string) {
  const expected = process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY;
  if (
    process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED !== "true" ||
    !expected ||
    serviceKey !== expected ||
    expected === process.env.CONVEX_SERVICE_ROLE_KEY ||
    expected === process.env.CONVEX_USER_RESEARCH_SERVICE_KEY
  )
    throw new Error("Unauthorized: Invalid egress abuse review service key");
}

const runArgs = {
  serviceKey: v.string(),
  userId: v.string(),
  chatId: v.string(),
  runId: v.string(),
  burstStart: v.number(),
  burstEnd: v.number(),
};
type Burst = { burstStart: number; burstEnd: number };

function assertBurst({ burstStart, burstEnd }: Burst) {
  if (
    !Number.isSafeInteger(burstStart) ||
    !Number.isSafeInteger(burstEnd) ||
    burstEnd <= burstStart ||
    burstEnd - burstStart > MAX_BURST_SPAN_MS
  )
    throw new Error("Invalid burst window");
}

type Overlap = "overlaps" | "disjoint" | "unknown";
const overlapValidator = v.union(
  v.literal("overlaps"),
  v.literal("disjoint"),
  v.literal("unknown"),
  v.literal("unavailable"),
);

/** Overlap with the burst; an open end means the run is still active now. */
function overlap(
  burst: Burst,
  start: number | undefined,
  end: number | "open" | undefined,
): Overlap {
  if (start === undefined) return "unknown";
  if (start > burst.burstEnd + CLOCK_SKEW_MS) return "disjoint";
  if (end === "open") return "overlaps";
  if (end === undefined) return "unknown";
  return end < burst.burstStart - CLOCK_SKEW_MS ? "disjoint" : "overlaps";
}

async function ownedChat(ctx: QueryCtx, userId: string, chatId: string) {
  const chat = await ctx.db
    .query("chats")
    .withIndex("by_chat_id", (q) => q.eq("id", chatId))
    .unique();
  return chat &&
    chat.user_id === userId &&
    !chat.deletion_started_at &&
    !(await isUserDeletionFenced(ctx.db, userId))
    ? chat
    : null;
}

/**
 * Newest-first bounded scan of one owned chat. Run timing is the persisted
 * generation start and duration of the run's own assistant rows.
 */
async function inspectParentRun(
  ctx: QueryCtx,
  args: Burst & { userId: string; chatId: string; runId: string },
) {
  const chat = await ownedChat(ctx, args.userId, args.chatId);
  if (!chat) return null;
  const rows: Doc<"messages">[] = [];
  let bytes = 0;
  let historyTruncated = false;
  for await (const row of ctx.db
    .query("messages")
    .withIndex("by_chat_id", (q) => q.eq("chat_id", args.chatId))
    .order("desc")) {
    if (rows.length >= MAX_SCAN || bytes >= MAX_SCAN_BYTES) {
      historyTruncated = true;
      break;
    }
    bytes += getDocumentSize(row);
    if (row.user_id === args.userId) rows.push(row);
  }
  rows.reverse();
  const runRows = rows.filter(
    (row) => row.role === "assistant" && row.trigger_run_id === args.runId,
  );
  const active = chat.active_trigger_run_id === args.runId;
  const starts = runRows.map((row) => row.generation_started_at);
  const timed = starts.length > 0 && starts.every((s) => typeof s === "number");
  const runStart = timed ? Math.min(...(starts as number[])) : undefined;
  let runEnd: number | "open" | undefined;
  if (active) runEnd = "open";
  else if (
    timed &&
    runRows.every((row) => typeof row.generation_time_ms === "number")
  )
    runEnd = Math.max(
      ...runRows.map(
        (row) => row.generation_started_at! + row.generation_time_ms!,
      ),
    );
  const status = overlap(args, runStart, runEnd);
  return {
    rows,
    runRows,
    active,
    historyTruncated,
    runStart,
    runEnd,
    // Older rows of the run beyond the scan could place it during the burst.
    status:
      historyTruncated && status === "disjoint" ? ("unknown" as const) : status,
  };
}

/**
 * Whether one recorded acquisition link's run could have been active during
 * the burst. `unknown` is plausible, including a parent run that looks
 * disjoint in a truncated scan; `unavailable` means the linked chat is
 * missing, deleted or owned by someone else.
 */
export const matchRun = query({
  args: {
    ...runArgs,
    runKind: v.union(v.literal("parent"), v.literal("subagent")),
  },
  returns: v.object({ status: overlapValidator }),
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    assertBurst(args);
    if (args.runKind === "parent") {
      const run = await inspectParentRun(ctx, args);
      return { status: run ? run.status : ("unavailable" as const) };
    }
    if (!(await ownedChat(ctx, args.userId, args.chatId)))
      return { status: "unavailable" as const };
    const children = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_and_chat", (q) =>
        q.eq("user_id", args.userId).eq("chat_id", args.chatId),
      )
      .order("desc")
      .take(MAX_SUBAGENT_SCAN);
    const child = children.find((row) => row.trigger_run_id === args.runId);
    if (!child) return { status: "unknown" as const };
    return {
      status: overlap(
        args,
        child.started_at ?? child.created_at,
        child.completed_at ??
          (ACTIVE_SUBAGENT.has(child.status) ? "open" : undefined),
      ),
    };
  },
});

const unavailableReason = v.union(
  v.literal("run_mismatch"),
  v.literal("subagent_overlap"),
  v.literal("concurrent_run"),
  v.literal("incomplete"),
);

function clip(value: string) {
  return {
    text: value.slice(0, MAX_TEXT_CHARS).replace(/[\uD800-\uDBFF]$/, ""),
    truncated: value.length > MAX_TEXT_CHARS,
  };
}

function userText(parts: unknown[]) {
  return parts
    .flatMap((part) => {
      const candidate = part as { type?: unknown; text?: unknown } | null;
      return candidate?.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("\n")
    .trim();
}

type TerminalPart = {
  type?: unknown;
  state?: unknown;
  toolCallId?: unknown;
  input?: { command?: unknown; action?: unknown; input?: unknown };
  output?: { result?: Record<string, unknown> };
};

function commandWasStarted(part: TerminalPart) {
  const receipt = part.output?.result;
  if (!receipt || receipt.approvalDenied === true) return false;
  return (
    receipt.processStarted === true ||
    (typeof receipt.pid === "number" && receipt.pid > 0) ||
    (typeof receipt.session === "string" && receipt.session.length > 0)
  );
}

/**
 * Re-verifies the single matched run, then returns only stored user text and
 * the inputs of that run's completed terminal tool calls. No tool output,
 * reasoning, system or hidden text, files, or other runs' parts.
 */
export const readRunEvidence = query({
  args: runArgs,
  returns: v.union(
    v.object({ status: v.literal("unavailable"), reason: unavailableReason }),
    v.object({
      status: v.literal("ok"),
      runStart: v.number(),
      runEnd: v.union(v.number(), v.null()),
      userMessages: v.array(
        v.object({
          messageId: v.string(),
          text: v.string(),
          truncated: v.boolean(),
        }),
      ),
      commands: v.array(
        v.object({
          messageId: v.string(),
          toolCallId: v.string(),
          tool: v.union(
            v.literal("run_terminal_cmd"),
            v.literal("interact_terminal_session"),
          ),
          text: v.string(),
          truncated: v.boolean(),
        }),
      ),
      coverage: v.object({
        rawReads: v.number(),
        historyTruncated: v.boolean(),
        userMessagesOmitted: v.number(),
        commandsOmitted: v.number(),
        incompleteToolCalls: v.number(),
        runActive: v.boolean(),
      }),
    }),
  ),
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    assertBurst(args);
    const unavailable = (
      reason:
        "run_mismatch" | "subagent_overlap" | "concurrent_run" | "incomplete",
    ) => ({
      status: "unavailable" as const,
      reason,
    });
    const run = await inspectParentRun(ctx, args);
    if (!run || run.status !== "overlaps") return unavailable("run_mismatch");
    if (!run.runRows.length || run.runStart === undefined)
      return unavailable("incomplete");

    // Subagents of this run share its workspace, but their commands are not
    // stored as chat messages: abstain whenever one may have overlapped.
    const children = await ctx.db
      .query("subagent_runs")
      .withIndex("by_user_chat_and_parent_run", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("chat_id", args.chatId)
          .eq("parent_trigger_run_id", args.runId),
      )
      .take(MAX_SUBAGENT_SCAN + 1);
    if (
      children.length > MAX_SUBAGENT_SCAN ||
      children.some(
        (child) =>
          overlap(
            args,
            child.started_at ?? child.created_at,
            child.completed_at ??
              (ACTIVE_SUBAGENT.has(child.status) ? "open" : undefined),
          ) !== "disjoint",
      )
    )
      return unavailable("subagent_overlap");
    // Another root run active now may have shared the account's workspace.
    // This reads run markers only, never chat content.
    const roots = await ctx.db
      .query("chats")
      .withIndex("by_user_and_active_trigger_run", (q) =>
        q.eq("user_id", args.userId).gt("active_trigger_run_id", ""),
      )
      .take(MAX_ACTIVE_ROOTS + 1);
    if (roots.some((chat) => chat.active_trigger_run_id !== args.runId))
      return unavailable("concurrent_run");

    const lastRunRow = run.runRows[run.runRows.length - 1]._creationTime;
    let laterEditedMessages = 0;
    const users = run.rows.flatMap((row) => {
      if (
        row.role !== "user" ||
        row.is_hidden === true ||
        row._creationTime > lastRunRow
      )
        return [];
      if (row.update_time > args.burstEnd + CLOCK_SKEW_MS) {
        laterEditedMessages++;
        return [];
      }
      const text = userText(row.parts);
      return text ? [{ messageId: row.id, ...clip(text) }] : [];
    });

    const commands: Array<{
      messageId: string;
      toolCallId: string;
      tool: "run_terminal_cmd" | "interact_terminal_session";
      text: string;
      truncated: boolean;
    }> = [];
    let incompleteToolCalls = 0;
    for (const row of run.runRows) {
      if (
        row.is_hidden ||
        row.is_browser_handoff ||
        row.finish_reason === "trigger_crashed_client_saved"
      ) {
        incompleteToolCalls++;
        continue;
      }
      for (const raw of row.parts) {
        const part = (raw ?? {}) as TerminalPart;
        const tool =
          part.type === "tool-run_terminal_cmd"
            ? ("run_terminal_cmd" as const)
            : part.type === "tool-interact_terminal_session"
              ? ("interact_terminal_session" as const)
              : undefined;
        if (!tool) continue;
        // Interactive keystrokes may contain a password, a reply, or a
        // command. Leave the run for an operator without reading this input.
        if (tool === "interact_terminal_session") {
          if (part.input?.action === "send") incompleteToolCalls++;
          continue;
        }
        if (part.input?.action && part.input.action !== "exec") continue;
        const value = part.input?.command;
        if (
          part.state !== "output-available" ||
          !commandWasStarted(part) ||
          typeof part.toolCallId !== "string" ||
          !part.toolCallId ||
          part.toolCallId.length > 128 ||
          typeof value !== "string" ||
          !value.trim()
        ) {
          incompleteToolCalls++;
          continue;
        }
        commands.push({
          messageId: row.id,
          toolCallId: part.toolCallId,
          tool,
          ...clip(value),
        });
      }
    }

    const keptUsers = users.slice(-MAX_USER_MESSAGES);
    const keptCommands = commands.slice(-MAX_COMMANDS);
    return {
      status: "ok" as const,
      runStart: run.runStart,
      runEnd: typeof run.runEnd === "number" ? run.runEnd : null,
      userMessages: keptUsers,
      commands: keptCommands,
      coverage: {
        rawReads: run.rows.length,
        historyTruncated: run.historyTruncated,
        userMessagesOmitted:
          laterEditedMessages + users.length - keptUsers.length,
        commandsOmitted: commands.length - keptCommands.length,
        incompleteToolCalls,
        runActive: run.active,
      },
    };
  },
});

/**
 * Creates the operator case once per reference. An existing case, including
 * any operator review, notes, status or erasure, is never changed.
 */
export const recordCase = mutation({
  args: {
    serviceKey: v.string(),
    reference: v.string(),
    digest: v.string(),
    ciphertext: v.string(),
  },
  returns: v.object({
    outcome: v.union(v.literal("created"), v.literal("existing")),
  }),
  handler: async (ctx, args) => {
    authorize(args.serviceKey);
    if (!REFERENCE.test(args.reference) || !DIGEST.test(args.digest))
      throw new Error("Invalid review case identity");
    boundedAbuseCiphertext(args.ciphertext, true);
    const existing = await ctx.db
      .query("abuse_cases")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .unique();
    if (existing) return { outcome: "existing" as const };
    const now = Date.now();
    const caseId = await ctx.db.insert("abuse_cases", {
      reference: args.reference,
      digest: args.digest,
      kind: "abuse",
      ciphertext: args.ciphertext,
      status: "new",
      revision: 0,
      // Ordinary retention: the operator can erase after resolution.
      evidenceHold: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("abuse_events", {
      caseId,
      actor: ACTOR,
      kind: "received",
      createdAt: now,
    });
    return { outcome: "created" as const };
  },
});
