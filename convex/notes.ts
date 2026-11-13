import { mutation, query } from "./lib/serviceFunctions";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { validateServiceKey } from "./lib/utils";
import type { Doc, Id } from "./_generated/dataModel";
import {
  getRecheckState,
  normalizeNoteTarget,
  safeCutIndex,
} from "../lib/notes/policy";

// Note: Keep in sync with VALID_NOTE_CATEGORIES in types/chat.ts
const VALID_CATEGORIES = [
  "general",
  "findings",
  "methodology",
  "questions",
  "plan",
] as const;

type NoteCategory = (typeof VALID_CATEGORIES)[number];

/**
 * Generate a random 5-character string for note IDs
 */
function generateNoteId(): string {
  return Math.random().toString(36).substring(2, 7);
}

/**
 * Estimate token count for a note (title + content + category + tags)
 * Uses ~4 characters per token estimation
 */
function estimateNoteTokens(
  title: string,
  content: string,
  category: string,
  tags: string[],
): number {
  const totalChars =
    title.length + content.length + category.length + tags.join(",").length;
  return Math.ceil(totalChars / 4);
}

/** Scoped notes belong to relevant recall and must never enter the legacy dump. */
const isScopedNote = (note: Doc<"notes">) =>
  note.target !== undefined || note.project_id !== undefined;

const clipText = (text: string, maxChars: number) => {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, safeCutIndex(text, maxChars)).trimEnd()}…`,
    truncated: true,
  };
};

const NOTE_PREVIEW_CHARS = 280;
const NOTE_TITLE_CHARS = 200;
const NOTE_LIST_DEFAULT_PAGE = 20;
const NOTE_LIST_MAX_PAGE = 50;
const NOTE_GET_MAX_CHARS = 24_000;
const RECALL_MAX_TARGET_KEYS = 24;
// Per eligible scope (unprojected, current project).
const RECALL_PER_TARGET = 6;
const RECALL_LABEL_SCAN = 15;
const RECALL_GENERAL_SCAN = 25;
const RECALL_SEARCH_SCAN = 10;
const RECALL_EXCERPT_CHARS = 1_200;
// Legacy notes have unbounded tags; responses carry a bounded subset.
const NOTE_MAX_TAGS = 12;
const NOTE_TAG_CHARS = 64;

const recheckValidator = v.optional(
  v.union(v.literal("recheck_due"), v.literal("observation_date_unknown")),
);

const noteMetadata = (note: Doc<"notes">, now: number) => ({
  note_id: note.note_id,
  title: clipText(note.title, NOTE_TITLE_CHARS).text,
  category: note.category,
  tags: note.tags
    .slice(0, NOTE_MAX_TAGS)
    .map((tag) => clipText(tag, NOTE_TAG_CHARS).text),
  target: note.target,
  observed_at: note.observed_at,
  recheck_after: note.recheck_after,
  updated_at: note.updated_at,
  recheck: getRecheckState(note, now),
});

const noteMetadataFields = {
  note_id: v.string(),
  title: v.string(),
  category: v.string(),
  tags: v.array(v.string()),
  target: v.optional(v.string()),
  observed_at: v.optional(v.number()),
  recheck_after: v.optional(v.number()),
  updated_at: v.number(),
  recheck: recheckValidator,
};

const noteCategoryValidator = v.union(
  v.literal("general"),
  v.literal("findings"),
  v.literal("methodology"),
  v.literal("questions"),
  v.literal("plan"),
);

/** Returns a normalized target, or an error the model can correct. */
const resolveTargetArg = (
  raw: string | undefined,
): { target?: string; error?: string } => {
  if (raw === undefined) return {};
  const result = normalizeNoteTarget(raw);
  return result.ok ? { target: result.target } : { error: result.error };
};

const validateObservedAt = (value: number | undefined, now: number) =>
  value === undefined ||
  (Number.isFinite(value) && value > 0 && value <= now + 5 * 60 * 1000);

/**
 * Create a new note with service key authentication (for backend use)
 */
export const createNoteForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    title: v.string(),
    content: v.string(),
    category: v.optional(
      v.union(
        v.literal("general"),
        v.literal("findings"),
        v.literal("methodology"),
        v.literal("questions"),
        v.literal("plan"),
      ),
    ),
    tags: v.optional(v.array(v.string())),
    /** Server-supplied source chat; associates the note with its project. */
    chatId: v.optional(v.string()),
    target: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    recheckAfter: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
    note_id: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    // Validate title
    if (!args.title || !args.title.trim()) {
      return { success: false, error: "Title cannot be empty" };
    }

    // Validate content
    if (!args.content || !args.content.trim()) {
      return { success: false, error: "Content cannot be empty" };
    }

    const category: NoteCategory = args.category || "general";
    const now = Date.now();
    const { target, error: targetError } = resolveTargetArg(args.target);
    if (targetError) return { success: false, error: targetError };
    if (!validateObservedAt(args.observedAt, now)) {
      return { success: false, error: "observed_at cannot be in the future" };
    }
    let projectId: Id<"projects"> | undefined;
    if (args.chatId) {
      const chat = await ctx.db
        .query("chats")
        .withIndex("by_chat_id", (q) => q.eq("id", args.chatId!))
        .unique();
      // Only the caller's own chat can place a note in a project.
      if (chat?.user_id === args.userId) projectId = chat.project_id;
    }
    const tags = args.tags || [];
    const tokens = estimateNoteTokens(
      args.title.trim(),
      args.content.trim(),
      category,
      tags,
    );

    // Generate unique note ID with collision check
    const maxAttempts = 5;
    let noteId: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidateId = generateNoteId();
      const existing = await ctx.db
        .query("notes")
        .withIndex("by_note_id", (q) => q.eq("note_id", candidateId))
        .first();

      if (!existing) {
        noteId = candidateId;
        break;
      }
    }

    if (!noteId) {
      return { success: false, error: "Failed to generate unique note ID" };
    }

    try {
      await ctx.db.insert("notes", {
        user_id: args.userId,
        note_id: noteId,
        title: args.title.trim(),
        content: args.content.trim(),
        category,
        tags,
        tokens,
        updated_at: now,
        ...(target !== undefined && { target }),
        ...(projectId !== undefined && { project_id: projectId }),
        ...(args.observedAt !== undefined && { observed_at: args.observedAt }),
        ...(args.recheckAfter !== undefined && {
          recheck_after: args.recheckAfter,
        }),
      });

      return { success: true, note_id: noteId };
    } catch (error) {
      console.error("Failed to create note:", error);
      if (error instanceof ConvexError) {
        throw error;
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create note",
      };
    }
  },
});

/**
 * Get notes for backend processing (for system prompt injection)
 * Enforces token limit based on user plan.
 * Returns notes sorted by updated_at (newest first)
 */
export const getNotesForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    subscription: v.optional(
      v.union(
        v.literal("free"),
        v.literal("pro"),
        v.literal("pro-plus"),
        v.literal("ultra"),
        v.literal("team"),
      ),
    ),
  },
  returns: v.array(
    v.object({
      note_id: v.string(),
      title: v.string(),
      content: v.string(),
      category: v.string(),
      tags: v.array(v.string()),
      updated_at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      // Get only "general" category notes for system prompt injection
      // Other categories must be retrieved via list_notes tool
      const notes = ctx.db
        .query("notes")
        .withIndex("by_user_and_category_and_updated", (q) =>
          q.eq("user_id", args.userId).eq("category", "general"),
        )
        .order("desc");

      // Calculate total tokens and enforce token limit based on subscription
      // Default to free tier (5000) when subscription is not provided
      const tokenLimit =
        !args.subscription || args.subscription === "free" ? 5000 : 15000;
      let totalTokens = 0;
      const validNotes = [];
      let scanned = 0;

      // A prompt needs only a bounded prefix, not every note in the account.
      for await (const note of notes) {
        // Skipped scoped notes still count, so skipping cannot scan unboundedly.
        if (++scanned > 200) break;
        // Target/project notes are recalled only by relevance, even after a
        // rollback disables recall; they must not leak into every chat.
        if (isScopedNote(note)) continue;
        const tokensValue = Number(note.tokens);
        const safeTokens =
          Number.isFinite(tokensValue) && tokensValue > 0
            ? tokensValue
            : Math.max(
                1,
                estimateNoteTokens(
                  note.title,
                  note.content,
                  note.category,
                  note.tags,
                ),
              );
        if (totalTokens + safeTokens <= tokenLimit) {
          totalTokens += safeTokens;
          validNotes.push(note);
          // Also bound legacy/tiny notes whose stored token counts are too low.
          if (validNotes.length >= 100 || totalTokens >= tokenLimit) break;
        } else {
          // Token limit exceeded, stop adding notes
          break;
        }
      }

      return validNotes.map((note) => ({
        note_id: note.note_id,
        title: note.title,
        content: note.content,
        category: note.category,
        tags: note.tags,
        updated_at: note.updated_at,
      }));
    } catch (error) {
      console.error("Failed to get notes for backend:", error);
      return [];
    }
  },
});

/**
 * List and filter notes with service key authentication (for backend use)
 */
export const listNotesForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    category: v.optional(
      v.union(
        v.literal("general"),
        v.literal("findings"),
        v.literal("methodology"),
        v.literal("questions"),
        v.literal("plan"),
      ),
    ),
    tags: v.optional(v.array(v.string())),
    search: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    notes: v.array(
      v.object({
        note_id: v.string(),
        title: v.string(),
        content: v.string(),
        category: v.string(),
        tags: v.array(v.string()),
        _creationTime: v.number(),
        updated_at: v.number(),
      }),
    ),
    total_count: v.number(),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      let notes;

      // Use search index if search query is provided
      if (args.search && args.search.trim()) {
        notes = await ctx.db
          .query("notes")
          .withSearchIndex("search_notes", (q) => {
            let searchQuery = q
              .search("content", args.search!)
              .eq("user_id", args.userId);
            if (args.category) {
              searchQuery = searchQuery.eq("category", args.category);
            }
            return searchQuery;
          })
          .collect();
      } else if (args.category) {
        // Use category index for filtering
        notes = await ctx.db
          .query("notes")
          .withIndex("by_user_and_category", (q) =>
            q.eq("user_id", args.userId).eq("category", args.category!),
          )
          .collect();
      } else {
        // Get all notes for user
        notes = await ctx.db
          .query("notes")
          .withIndex("by_user_and_updated", (q) => q.eq("user_id", args.userId))
          .order("desc")
          .collect();
      }

      // Filter by tags if provided (OR logic - match any tag)
      if (args.tags && args.tags.length > 0) {
        const tagSet = new Set(args.tags);
        notes = notes.filter((note) =>
          note.tags.some((tag) => tagSet.has(tag)),
        );
      }

      // Sort by _creationTime descending (newest first)
      notes.sort((a, b) => b._creationTime - a._creationTime);

      const totalCount = notes.length;

      const MAX_RESPONSE_TOKENS = 4096;
      let totalTokens = 0;
      const resultNotes = [];

      for (const note of notes) {
        const noteTokens = note.tokens || 0;
        // Always include at least one note, then check token limit
        if (
          resultNotes.length > 0 &&
          totalTokens + noteTokens > MAX_RESPONSE_TOKENS
        ) {
          break;
        }
        totalTokens += noteTokens;
        resultNotes.push({
          note_id: note.note_id,
          title: note.title,
          content: note.content,
          category: note.category,
          tags: note.tags,
          _creationTime: note._creationTime,
          updated_at: note.updated_at,
        });
      }

      const isTruncated = resultNotes.length < totalCount;
      return {
        success: true,
        notes: resultNotes,
        total_count: totalCount,
        message: isTruncated
          ? `Showing ${resultNotes.length} of ${totalCount} notes. Use category or search filters to find specific notes.`
          : undefined,
      };
    } catch (error) {
      console.error("Failed to list notes:", error);
      return {
        success: false,
        notes: [],
        total_count: 0,
        error: error instanceof Error ? error.message : "Failed to list notes",
      };
    }
  },
});

/**
 * Compact, paginated note browsing for the relevant-recall tool set.
 * Returns bounded previews and metadata; get_note reads full content.
 */
export const listNoteSummariesForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    category: v.optional(noteCategoryValidator),
    tags: v.optional(v.array(v.string())),
    search: v.optional(v.string()),
    target: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
    notes: v.array(
      v.object({
        ...noteMetadataFields,
        preview: v.string(),
        preview_truncated: v.boolean(),
      }),
    ),
    has_more: v.boolean(),
    next_cursor: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const { target, error: targetError } = resolveTargetArg(args.target);
    if (targetError)
      return { success: false, notes: [], has_more: false, error: targetError };
    const numItems = Math.max(
      1,
      Math.min(
        NOTE_LIST_MAX_PAGE,
        Math.floor(args.limit ?? NOTE_LIST_DEFAULT_PAGE),
      ),
    );
    const paginationOpts = { numItems, cursor: args.cursor ?? null };
    const search = args.search?.trim().slice(0, 200);

    try {
      const page = search
        ? await ctx.db
            .query("notes")
            .withSearchIndex("search_notes", (q) => {
              const scoped = q
                .search("content", search)
                .eq("user_id", args.userId);
              return args.category
                ? scoped.eq("category", args.category)
                : scoped;
            })
            .paginate(paginationOpts)
        : target !== undefined
          ? await ctx.db
              .query("notes")
              .withIndex("by_user_and_target_and_updated", (q) =>
                q.eq("user_id", args.userId).eq("target", target),
              )
              .order("desc")
              .paginate(paginationOpts)
          : args.category
            ? await ctx.db
                .query("notes")
                .withIndex("by_user_and_category_and_updated", (q) =>
                  q.eq("user_id", args.userId).eq("category", args.category!),
                )
                .order("desc")
                .paginate(paginationOpts)
            : await ctx.db
                .query("notes")
                .withIndex("by_user_and_updated", (q) =>
                  q.eq("user_id", args.userId),
                )
                .order("desc")
                .paginate(paginationOpts);

      // Page-local filters keep reads bounded; the cursor still advances past
      // every scanned note, so continuing never skips or repeats a note.
      const tagSet = args.tags?.length ? new Set(args.tags) : undefined;
      const now = Date.now();
      const notes = page.page
        .filter(
          (note) =>
            (!search || target === undefined || note.target === target) &&
            (!args.category || note.category === args.category) &&
            (!tagSet || note.tags.some((tag) => tagSet.has(tag))),
        )
        .map((note) => {
          const preview = clipText(note.content, NOTE_PREVIEW_CHARS);
          return {
            ...noteMetadata(note, now),
            preview: preview.text,
            preview_truncated: preview.truncated,
          };
        });
      return {
        success: true,
        notes,
        has_more: !page.isDone,
        next_cursor: page.isDone ? undefined : page.continueCursor,
      };
    } catch (error) {
      console.error("Failed to list note summaries:", error);
      return {
        success: false,
        notes: [],
        has_more: false,
        error: args.cursor
          ? "This cursor does not match the current filters or has expired. Restart without a cursor."
          : "Failed to list notes",
      };
    }
  },
});

/**
 * Reads one bounded page of a single owned note. The caller trims the page to
 * an exact token budget and continues from the returned offset.
 */
export const getNoteForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    noteId: v.string(),
    offset: v.optional(v.number()),
    maxChars: v.optional(v.number()),
  },
  returns: v.object({
    success: v.boolean(),
    note: v.optional(
      v.object({
        ...noteMetadataFields,
        content: v.string(),
        content_offset: v.number(),
        content_length: v.number(),
      }),
    ),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const note = await ctx.db
      .query("notes")
      .withIndex("by_note_id", (q) => q.eq("note_id", args.noteId))
      .first();
    // Other users' notes are indistinguishable from missing ones.
    if (!note || note.user_id !== args.userId) {
      return { success: false, error: `Note '${args.noteId}' not found` };
    }
    const requested = Math.floor(args.offset ?? 0);
    if (
      !Number.isFinite(requested) ||
      requested < 0 ||
      requested > note.content.length
    ) {
      return { success: false, error: "Invalid cursor for this note" };
    }
    const start = safeCutIndex(note.content, requested);
    const maxChars = Math.max(
      1,
      Math.min(
        NOTE_GET_MAX_CHARS,
        Math.floor(args.maxChars ?? NOTE_GET_MAX_CHARS),
      ),
    );
    const end = safeCutIndex(note.content, start + maxChars);
    return {
      success: true,
      note: {
        ...noteMetadata(note, Date.now()),
        content: note.content.slice(start, end),
        content_offset: start,
        content_length: note.content.length,
      },
    };
  },
});

/**
 * Bounded candidate set for automatic recall. Every read is indexed and
 * capped; project scope comes from a server-validated project, never input
 * the model controls. Lookup failures throw so callers keep prior context.
 */
export const getNoteRecallCandidatesForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    projectId: v.optional(v.string()),
    targets: v.array(v.string()),
    searchText: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      ...noteMetadataFields,
      excerpt: v.string(),
      excerpt_truncated: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const normalizedProjectId = args.projectId
      ? ctx.db.normalizeId("projects", args.projectId)
      : null;
    const project = normalizedProjectId
      ? await ctx.db.get(normalizedProjectId)
      : null;
    const projectId =
      project &&
      project.user_id === args.userId &&
      project.deletion_started_at === undefined
        ? project._id
        : undefined;

    const byId = new Map<string, Doc<"notes">>();
    const add = (notes: Doc<"notes">[]) => {
      for (const note of notes) {
        // Defensive: every read below is already scoped to an eligible project.
        if (note.project_id !== undefined && note.project_id !== projectId)
          continue;
        byId.set(note._id, note);
      }
    };
    // Unprojected notes apply everywhere; project notes only inside that
    // project. Each scope is read separately so other projects' newer notes
    // cannot consume the bounded reads.
    const scopes: (Id<"projects"> | undefined)[] = projectId
      ? [undefined, projectId]
      : [undefined];

    for (const scope of scopes) {
      for (const target of [...new Set(args.targets)].slice(
        0,
        RECALL_MAX_TARGET_KEYS,
      )) {
        add(
          await ctx.db
            .query("notes")
            .withIndex("by_user_and_project_and_target_and_updated", (q) =>
              q
                .eq("user_id", args.userId)
                .eq("project_id", scope)
                .eq("target", target),
            )
            .order("desc")
            .take(RECALL_PER_TARGET),
        );
      }
      add(
        await ctx.db
          .query("notes")
          .withIndex("by_user_and_project_and_target_and_updated", (q) =>
            q
              .eq("user_id", args.userId)
              .eq("project_id", scope)
              .gte("target", "label:")
              .lt("target", "label;"),
          )
          .take(RECALL_LABEL_SCAN),
      );
      add(
        await ctx.db
          .query("notes")
          .withIndex(
            "by_user_and_project_and_target_and_category_and_updated",
            (q) =>
              q
                .eq("user_id", args.userId)
                .eq("project_id", scope)
                .eq("target", undefined)
                .eq("category", "general"),
          )
          .order("desc")
          .take(RECALL_GENERAL_SCAN),
      );
      const searchText = args.searchText?.trim().slice(0, 200);
      if (searchText) {
        add(
          await ctx.db
            .query("notes")
            .withSearchIndex("search_notes", (q) =>
              q
                .search("content", searchText)
                .eq("user_id", args.userId)
                .eq("project_id", scope),
            )
            .take(RECALL_SEARCH_SCAN),
        );
      }
    }

    const now = Date.now();
    return [...byId.values()].map((note) => {
      const excerpt = clipText(note.content, RECALL_EXCERPT_CHARS);
      return {
        ...noteMetadata(note, now),
        excerpt: excerpt.text,
        excerpt_truncated: excerpt.truncated,
      };
    });
  },
});

/**
 * Update an existing note with service key authentication (for backend use)
 */
export const updateNoteForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    noteId: v.string(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    /** null clears the target. */
    target: v.optional(v.union(v.string(), v.null())),
    /** Only an explicit new observation advances observed_at. */
    observedAt: v.optional(v.number()),
    /** null clears the recheck date. */
    recheckAfter: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
    // Original note data before update (for before/after comparison)
    original: v.optional(
      v.object({
        title: v.string(),
        content: v.string(),
        category: v.string(),
        tags: v.array(v.string()),
      }),
    ),
    // Modified note data after update (for before/after comparison)
    modified: v.optional(
      v.object({
        title: v.string(),
        content: v.string(),
        category: v.string(),
        tags: v.array(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      // Find the note
      const note = await ctx.db
        .query("notes")
        .withIndex("by_note_id", (q) => q.eq("note_id", args.noteId))
        .first();

      if (!note) {
        return { success: false, error: `Note '${args.noteId}' not found` };
      }

      // Verify ownership
      if (note.user_id !== args.userId) {
        return {
          success: false,
          error: "Access denied: You don't own this note",
        };
      }

      // Check at least one field to update
      if (
        args.title === undefined &&
        args.content === undefined &&
        args.tags === undefined &&
        args.target === undefined &&
        args.observedAt === undefined &&
        args.recheckAfter === undefined
      ) {
        return {
          success: false,
          error:
            "At least one field (title, content, or tags) must be provided",
        };
      }

      // Validate fields if provided
      if (args.title !== undefined && !args.title.trim()) {
        return { success: false, error: "Title cannot be empty" };
      }

      if (args.content !== undefined && !args.content.trim()) {
        return { success: false, error: "Content cannot be empty" };
      }

      const { target, error: targetError } = resolveTargetArg(
        args.target ?? undefined,
      );
      if (targetError) return { success: false, error: targetError };
      if (!validateObservedAt(args.observedAt, Date.now())) {
        return { success: false, error: "observed_at cannot be in the future" };
      }

      // Determine final values for token calculation
      const finalTitle =
        args.title !== undefined ? args.title.trim() : note.title;
      const finalContent =
        args.content !== undefined ? args.content.trim() : note.content;
      const finalTags = args.tags !== undefined ? args.tags : note.tags;

      // Recalculate tokens
      const tokens = estimateNoteTokens(
        finalTitle,
        finalContent,
        note.category,
        finalTags,
      );

      // Build update object
      const updates: {
        title?: string;
        content?: string;
        tags?: string[];
        tokens: number;
        updated_at: number;
        target?: string | undefined;
        observed_at?: number;
        recheck_after?: number | undefined;
      } = {
        tokens,
        updated_at: Date.now(),
      };

      if (args.title !== undefined) {
        updates.title = args.title.trim();
      }
      if (args.content !== undefined) {
        updates.content = args.content.trim();
      }
      if (args.tags !== undefined) {
        updates.tags = args.tags;
      }
      // Patching a field to undefined removes it in Convex.
      if (args.target !== undefined) updates.target = target;
      if (args.observedAt !== undefined) updates.observed_at = args.observedAt;
      if (args.recheckAfter !== undefined)
        updates.recheck_after = args.recheckAfter ?? undefined;

      await ctx.db.patch(note._id, updates);

      return {
        success: true,
        original: {
          title: note.title,
          content: note.content,
          category: note.category,
          tags: note.tags,
        },
        modified: {
          title: finalTitle,
          content: finalContent,
          category: note.category,
          tags: finalTags,
        },
      };
    } catch (error) {
      console.error("Failed to update note:", error);
      if (error instanceof ConvexError) {
        throw error;
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update note",
      };
    }
  },
});

/**
 * Delete a note with service key authentication (for backend use)
 */
export const deleteNoteForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    noteId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    deleted_title: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    try {
      // Find the note
      const note = await ctx.db
        .query("notes")
        .withIndex("by_note_id", (q) => q.eq("note_id", args.noteId))
        .first();

      if (!note) {
        return { success: false, error: `Note '${args.noteId}' not found` };
      }

      // Verify ownership
      if (note.user_id !== args.userId) {
        return {
          success: false,
          error: "Access denied: You don't own this note",
        };
      }

      const deletedTitle = note.title;
      await ctx.db.delete(note._id);

      return { success: true, deleted_title: deletedTitle };
    } catch (error) {
      console.error("Failed to delete note:", error);
      if (error instanceof ConvexError) {
        throw error;
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete note",
      };
    }
  },
});

/**
 * Get paginated notes for frontend display (authenticated user)
 * Uses Convex's standard pagination for efficient database-level pagination
 */
export const getUserNotesPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        page: [],
        isDone: true,
        continueCursor: "",
      };
    }

    try {
      const result = await ctx.db
        .query("notes")
        .withIndex("by_user_and_updated", (q) =>
          q.eq("user_id", identity.subject),
        )
        .order("desc")
        .paginate(args.paginationOpts);

      return {
        page: result.page.map((note) => ({
          note_id: note.note_id,
          title: note.title,
          content: note.content,
          category: note.category,
          tags: note.tags,
          _creationTime: note._creationTime,
          updated_at: note.updated_at,
        })),
        isDone: result.isDone,
        continueCursor: result.continueCursor,
      };
    } catch (error) {
      console.error("Failed to get paginated notes:", error);
      return { page: [], isDone: true, continueCursor: "" };
    }
  },
});

/**
 * Get notes for frontend display (authenticated user)
 */
export const getUserNotes = query({
  args: {
    category: v.optional(
      v.union(
        v.literal("general"),
        v.literal("findings"),
        v.literal("methodology"),
        v.literal("questions"),
        v.literal("plan"),
      ),
    ),
  },
  returns: v.array(
    v.object({
      note_id: v.string(),
      title: v.string(),
      content: v.string(),
      category: v.string(),
      tags: v.array(v.string()),
      _creationTime: v.number(),
      updated_at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      let notes;

      if (args.category) {
        notes = await ctx.db
          .query("notes")
          .withIndex("by_user_and_category", (q) =>
            q.eq("user_id", identity.subject).eq("category", args.category!),
          )
          .collect();
      } else {
        notes = await ctx.db
          .query("notes")
          .withIndex("by_user_and_updated", (q) =>
            q.eq("user_id", identity.subject),
          )
          .order("desc")
          .collect();
      }

      return notes.map((note) => ({
        note_id: note.note_id,
        title: note.title,
        content: note.content,
        category: note.category,
        tags: note.tags,
        _creationTime: note._creationTime,
        updated_at: note.updated_at,
      }));
    } catch (error) {
      console.error("Failed to get user notes:", error);
      return [];
    }
  },
});

/**
 * Delete a specific note for the authenticated user
 */
export const deleteUserNote = mutation({
  args: {
    noteId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      const note = await ctx.db
        .query("notes")
        .withIndex("by_note_id", (q) => q.eq("note_id", args.noteId))
        .first();

      if (!note) {
        return null; // Idempotent - treat as successful
      }

      if (note.user_id !== identity.subject) {
        throw new ConvexError({
          code: "ACCESS_DENIED",
          message: "Access denied: You don't own this note",
        });
      }

      await ctx.db.delete(note._id);
      return null;
    } catch (error) {
      console.error("Failed to delete note:", error);
      if (error instanceof ConvexError) {
        throw error;
      }
      throw new ConvexError({
        code: "NOTE_DELETION_FAILED",
        message:
          error instanceof Error ? error.message : "Failed to delete note",
      });
    }
  },
});

/**
 * Create a new note for the authenticated user
 */
export const createUserNote = mutation({
  args: {
    title: v.string(),
    content: v.string(),
    category: v.optional(
      v.union(
        v.literal("general"),
        v.literal("findings"),
        v.literal("methodology"),
        v.literal("questions"),
        v.literal("plan"),
      ),
    ),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.object({
    success: v.boolean(),
    note_id: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    if (!args.title || !args.title.trim()) {
      return { success: false, error: "Title cannot be empty" };
    }

    if (!args.content || !args.content.trim()) {
      return { success: false, error: "Content cannot be empty" };
    }

    const category: NoteCategory = args.category || "general";
    const now = Date.now();
    const tags = args.tags || [];
    const tokens = estimateNoteTokens(
      args.title.trim(),
      args.content.trim(),
      category,
      tags,
    );

    const maxAttempts = 5;
    let noteId: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidateId = generateNoteId();
      const existing = await ctx.db
        .query("notes")
        .withIndex("by_note_id", (q) => q.eq("note_id", candidateId))
        .first();

      if (!existing) {
        noteId = candidateId;
        break;
      }
    }

    if (!noteId) {
      return { success: false, error: "Failed to generate unique note ID" };
    }

    try {
      await ctx.db.insert("notes", {
        user_id: identity.subject,
        note_id: noteId,
        title: args.title.trim(),
        content: args.content.trim(),
        category,
        tags,
        tokens,
        updated_at: now,
      });

      return { success: true, note_id: noteId };
    } catch (error) {
      console.error("Failed to create note:", error);
      if (error instanceof ConvexError) {
        throw error;
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create note",
      };
    }
  },
});

/**
 * Update an existing note for the authenticated user
 */
export const updateUserNote = mutation({
  args: {
    noteId: v.string(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
    original: v.optional(
      v.object({
        title: v.string(),
        content: v.string(),
        category: v.string(),
        tags: v.array(v.string()),
      }),
    ),
    modified: v.optional(
      v.object({
        title: v.string(),
        content: v.string(),
        category: v.string(),
        tags: v.array(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      const note = await ctx.db
        .query("notes")
        .withIndex("by_note_id", (q) => q.eq("note_id", args.noteId))
        .first();

      if (!note) {
        return { success: false, error: `Note '${args.noteId}' not found` };
      }

      if (note.user_id !== identity.subject) {
        throw new ConvexError({
          code: "ACCESS_DENIED",
          message: "Access denied: You don't own this note",
        });
      }

      if (
        args.title === undefined &&
        args.content === undefined &&
        args.tags === undefined
      ) {
        return {
          success: false,
          error:
            "At least one field (title, content, or tags) must be provided",
        };
      }

      if (args.title !== undefined && !args.title.trim()) {
        return { success: false, error: "Title cannot be empty" };
      }

      if (args.content !== undefined && !args.content.trim()) {
        return { success: false, error: "Content cannot be empty" };
      }

      const finalTitle =
        args.title !== undefined ? args.title.trim() : note.title;
      const finalContent =
        args.content !== undefined ? args.content.trim() : note.content;
      const finalTags = args.tags !== undefined ? args.tags : note.tags;

      const tokens = estimateNoteTokens(
        finalTitle,
        finalContent,
        note.category,
        finalTags,
      );

      const updates: {
        title?: string;
        content?: string;
        tags?: string[];
        tokens: number;
        updated_at: number;
      } = {
        tokens,
        updated_at: Date.now(),
      };

      if (args.title !== undefined) {
        updates.title = args.title.trim();
      }
      if (args.content !== undefined) {
        updates.content = args.content.trim();
      }
      if (args.tags !== undefined) {
        updates.tags = args.tags;
      }

      await ctx.db.patch(note._id, updates);

      return {
        success: true,
        original: {
          title: note.title,
          content: note.content,
          category: note.category,
          tags: note.tags,
        },
        modified: {
          title: finalTitle,
          content: finalContent,
          category: note.category,
          tags: finalTags,
        },
      };
    } catch (error) {
      console.error("Failed to update note:", error);
      if (error instanceof ConvexError) {
        throw error;
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update note",
      };
    }
  },
});

/**
 * Search notes for the authenticated user
 */
export const searchUserNotes = query({
  args: {
    search: v.string(),
    category: v.optional(
      v.union(
        v.literal("general"),
        v.literal("findings"),
        v.literal("methodology"),
        v.literal("questions"),
        v.literal("plan"),
      ),
    ),
  },
  returns: v.array(
    v.object({
      note_id: v.string(),
      title: v.string(),
      content: v.string(),
      category: v.string(),
      tags: v.array(v.string()),
      _creationTime: v.number(),
      updated_at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      let notes;

      if (args.search.trim()) {
        notes = await ctx.db
          .query("notes")
          .withSearchIndex("search_notes", (q) => {
            let searchQuery = q
              .search("content", args.search)
              .eq("user_id", identity.subject);
            if (args.category) {
              searchQuery = searchQuery.eq("category", args.category);
            }
            return searchQuery;
          })
          .collect();
      } else if (args.category) {
        notes = await ctx.db
          .query("notes")
          .withIndex("by_user_and_category", (q) =>
            q.eq("user_id", identity.subject).eq("category", args.category!),
          )
          .collect();
      } else {
        notes = await ctx.db
          .query("notes")
          .withIndex("by_user_and_updated", (q) =>
            q.eq("user_id", identity.subject),
          )
          .order("desc")
          .collect();
      }

      notes.sort((a, b) => b._creationTime - a._creationTime);

      return notes.map((note) => ({
        note_id: note.note_id,
        title: note.title,
        content: note.content,
        category: note.category,
        tags: note.tags,
        _creationTime: note._creationTime,
        updated_at: note.updated_at,
      }));
    } catch (error) {
      console.error("Failed to search notes:", error);
      return [];
    }
  },
});

/**
 * Delete all notes for the authenticated user
 */
export const deleteAllUserNotes = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      const notes = await ctx.db
        .query("notes")
        .withIndex("by_user_and_updated", (q) =>
          q.eq("user_id", identity.subject),
        )
        .collect();

      for (const note of notes) {
        await ctx.db.delete(note._id);
      }

      return null;
    } catch (error) {
      console.error("Failed to delete all notes:", error);
      if (error instanceof ConvexError) {
        throw error;
      }
      throw new ConvexError({
        code: "NOTE_DELETION_FAILED",
        message:
          error instanceof Error ? error.message : "Failed to delete notes",
      });
    }
  },
});
