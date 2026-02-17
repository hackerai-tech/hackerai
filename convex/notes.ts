import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { validateServiceKey } from "./lib/utils";

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
 * Enforces token limit based on user plan (same as memories)
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
      const notes = await ctx.db
        .query("notes")
        .withIndex("by_user_and_category", (q) =>
          q.eq("user_id", args.userId).eq("category", "general"),
        )
        .order("desc")
        .collect();

      // Sort by updated_at descending (newest first)
      notes.sort((a, b) => b.updated_at - a.updated_at);

      // Calculate total tokens and enforce token limit based on subscription
      // Default to free tier (5000) when subscription is not provided
      const tokenLimit =
        !args.subscription || args.subscription === "free" ? 5000 : 15000;
      let totalTokens = 0;
      const validNotes = [];

      for (const note of notes) {
        const tokensValue = Number(note.tokens);
        const safeTokens =
          Number.isFinite(tokensValue) && tokensValue > 0 ? tokensValue : 0;
        if (totalTokens + safeTokens <= tokenLimit) {
          totalTokens += safeTokens;
          validNotes.push(note);
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
        args.tags === undefined
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
