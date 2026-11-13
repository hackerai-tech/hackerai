import { tool } from "ai";
import type { ToolContext } from "@/types";
import {
  createNote,
  listNotes,
  listNoteSummaries,
  getNoteContent,
  updateNote,
  deleteNote,
} from "@/lib/db/actions";
import {
  fitTextToTokens,
  parseObservedAt,
  parseRecheckAfter,
  safeCutIndex,
} from "@/lib/notes/policy";
import { safeCountTokens } from "@/lib/token-utils";
import {
  createNoteTool,
  createNoteScopedTool,
  type CreateNoteScopedToolInput,
  deleteNoteTool,
  type DeleteNoteToolInput,
  getNoteTool,
  type GetNoteToolInput,
  listNotesTool,
  listNotesScopedTool,
  type ListNotesScopedToolInput,
  type NullishOptionalQueryFilterValue,
  NULLISH_OPTIONAL_QUERY_FILTER_PATTERN,
  updateNoteTool,
  updateNoteScopedTool,
  type UpdateNoteScopedToolInput,
} from "./schemas";

/** Treats explicit nulls and common model placeholders as omitted query filters. */
const isNullishOptionalQueryFilter = (
  value: string | null | undefined,
): value is NullishOptionalQueryFilterValue | null | undefined =>
  value == null || NULLISH_OPTIONAL_QUERY_FILTER_PATTERN.test(value);

const optionalFilter = (value: string | null | undefined) =>
  isNullishOptionalQueryFilter(value) ? undefined : value;

const isoDate = (value: number) => new Date(value).toISOString().slice(0, 10);

type NoteMetadata = {
  note_id: string;
  title: string;
  category: string;
  tags: string[];
  target?: string;
  observed_at?: number;
  updated_at: number;
  recheck?: "recheck_due" | "observation_date_unknown";
};

/** One compact line of metadata the model can reason about without raw epochs. */
const describeNote = (note: NoteMetadata) =>
  [
    note.category,
    note.target ? `target: ${note.target}` : undefined,
    note.observed_at !== undefined
      ? `observed ${isoDate(note.observed_at)}`
      : note.recheck
        ? "observation date unknown"
        : undefined,
    note.recheck === "recheck_due" ? "recheck due" : undefined,
    `updated ${isoDate(note.updated_at)}`,
    note.tags.length ? `tags: ${note.tags.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");

/** Exact token cap for every model-facing list_notes/get_note response. */
export const NOTE_TOOL_RESPONSE_TOKENS = 4_000;
const NOTE_HEADER_TOKENS = 1_200;

/** Token-bounded text; the ellipsis is reserved inside the budget. */
const clampTokens = (text: string, maxTokens: number) => {
  const fitted = fitTextToTokens(
    text,
    Math.max(0, maxTokens - 1),
    safeCountTokens,
  );
  return fitted.truncated ? `${fitted.text.trimEnd()}…` : fitted.text;
};

type ListedNote = NoteMetadata & {
  preview: string;
  preview_truncated: boolean;
};

/**
 * Model text for one list page. Every returned note keeps its ID and the
 * continuation cursor is never cut; only per-note metadata/previews shrink.
 */
export function renderNoteList(list: {
  notes?: ListedNote[];
  has_more?: boolean;
  next_cursor?: string;
}): string {
  const notes = list.notes ?? [];
  const footer = list.has_more
    ? `More notes match. Continue with list_notes using the same filters and cursor "${list.next_cursor}".`
    : "No more matching notes.";
  if (notes.length === 0) return `No notes on this page.\n${footer}`;
  const parts = notes.map((note) => ({
    prefix: `- [${note.note_id}] `,
    body: `${note.title} (${describeNote(note)}): ${note.preview}${note.preview_truncated ? " [preview; use get_note for full content]" : ""}`,
  }));
  const full = `${parts.map((p) => p.prefix + p.body).join("\n")}\n${footer}`;
  if (safeCountTokens(full) <= NOTE_TOOL_RESPONSE_TOKENS) return full;

  const shortenedFooter = `${footer}\n[Some metadata and previews were shortened to fit; use get_note for a full note.]`;
  let perLine = Math.floor(
    (NOTE_TOOL_RESPONSE_TOKENS -
      safeCountTokens(shortenedFooter) -
      notes.length) /
      notes.length,
  );
  for (;;) {
    const text = `${parts
      .map(
        (p) =>
          p.prefix + clampTokens(p.body, perLine - safeCountTokens(p.prefix)),
      )
      .join("\n")}\n${shortenedFooter}`;
    // BPE counts are not additive across lines; verify the exact total.
    if (safeCountTokens(text) <= NOTE_TOOL_RESPONSE_TOKENS || perLine <= 1)
      return text;
    perLine = Math.floor(perLine * 0.9);
  }
}

type NotePage = NoteMetadata & {
  content: string;
  content_offset: number;
  content_length: number;
  next_cursor?: string;
};

/** Model text for one get_note page: bounded header, page body, cursor footer. */
export function renderNotePage(note: NotePage): string {
  const header = clampTokens(
    `[${note.note_id}] ${note.title} (${describeNote(note)})`,
    NOTE_HEADER_TOKENS,
  );
  const position =
    note.content_offset > 0 || note.next_cursor
      ? ` (characters ${note.content_offset}-${note.content_offset + note.content.length} of ${note.content_length})`
      : "";
  const footer = note.next_cursor
    ? `\n[Partial note. Continue with get_note cursor "${note.next_cursor}".]`
    : "";
  return `${header}${position}\n${note.content}${footer}`;
}

/**
 * Longest page of `note.content` whose full rendered response fits the cap.
 * Always advances at least one code point so paging terminates.
 */
function fitNotePage(note: Omit<NotePage, "next_cursor">) {
  const worstCase = renderNotePage({
    ...note,
    content: "",
    content_offset: note.content_length,
    next_cursor: String(note.content_length),
  });
  let budget = NOTE_TOOL_RESPONSE_TOKENS - safeCountTokens(worstCase) - 4;
  for (;;) {
    const page = fitTextToTokens(
      note.content,
      Math.max(0, budget),
      safeCountTokens,
    );
    const consumed =
      page.consumed > 0 || !note.content
        ? page.consumed
        : Math.max(1, safeCutIndex(note.content, 2));
    const end = note.content_offset + consumed;
    const result: NotePage = {
      ...note,
      content: note.content.slice(0, consumed),
      ...(end < note.content_length && { next_cursor: String(end) }),
    };
    const overshoot =
      safeCountTokens(renderNotePage(result)) - NOTE_TOOL_RESPONSE_TOKENS;
    if (overshoot <= 0 || consumed <= 2) return result;
    budget -= overshoot + 4;
  }
}

const errorText = (output: unknown) =>
  typeof output === "object" &&
  output !== null &&
  "error" in output &&
  (output as { success?: boolean }).success === false
    ? `Error: ${(output as { error: string }).error}`
    : undefined;

/**
 * Create a new personal note to record observations, findings, or research.
 * With relevant recall, the note may carry a target and observation dates and
 * is associated server-side with the current chat's project.
 */
export const createCreateNote = (context: ToolContext, recall = false) => {
  if (!recall) {
    return tool({
      ...createNoteTool,
      execute: async ({ title, content, category, tags }) =>
        await runCreate(context, { title, content, category, tags }),
    });
  }
  return tool({
    ...createNoteScopedTool,
    execute: async (input: CreateNoteScopedToolInput) => {
      const now = Date.now();
      const observed =
        input.observed_at === undefined
          ? undefined
          : parseObservedAt(input.observed_at, now);
      if (observed && !observed.ok)
        return { success: false, error: observed.error };
      const recheck =
        input.recheck_after === undefined
          ? undefined
          : parseRecheckAfter(input.recheck_after);
      if (recheck && !recheck.ok)
        return { success: false, error: recheck.error };
      return await runCreate(context, {
        title: input.title,
        content: input.content,
        category: input.category,
        tags: input.tags,
        chatId: context.chatId,
        target: input.target,
        observedAt: observed?.value,
        recheckAfter: recheck?.value,
      });
    },
  });
};

async function runCreate(
  context: ToolContext,
  args: Omit<Parameters<typeof createNote>[0], "userId">,
) {
  try {
    const result = await createNote({ userId: context.userID, ...args });

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Failed to create note",
      };
    }

    return {
      success: true,
      note_id: result.note_id,
      message: `Note '${args.title}' created successfully`,
    };
  } catch (error) {
    console.error("Create note tool error:", error);
    return {
      success: false,
      error: `Failed to create note: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * List and filter existing notes. With relevant recall, results are compact
 * paginated previews; get_note reads a note in full.
 */
export const createListNotes = (context: ToolContext, recall = false) => {
  if (!recall) {
    return tool({
      ...listNotesTool,
      execute: async ({ category, tags, search }) => {
        try {
          const result = await listNotes({
            userId: context.userID,
            category: optionalFilter(category) as
              Parameters<typeof listNotes>[0]["category"] | undefined,
            tags,
            search: optionalFilter(search),
          });

          if (!result.success) {
            return {
              success: false,
              error: result.error || "Failed to list notes",
            };
          }

          return {
            success: true,
            notes: result.notes,
            total_count: result.total_count,
          };
        } catch (error) {
          console.error("List notes tool error:", error);
          return {
            success: false,
            error: `Failed to list notes: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    });
  }
  return tool({
    ...listNotesScopedTool,
    execute: async (input: ListNotesScopedToolInput) => {
      try {
        const result = await listNoteSummaries({
          userId: context.userID,
          category: optionalFilter(input.category) as
            Parameters<typeof listNoteSummaries>[0]["category"] | undefined,
          tags: input.tags,
          search: optionalFilter(input.search),
          target: optionalFilter(input.target),
          cursor: input.cursor ?? undefined,
        });
        if (!result.success) {
          return {
            success: false,
            error: result.error || "Failed to list notes",
          };
        }
        return {
          success: true,
          notes: result.notes,
          has_more: result.has_more,
          ...(result.next_cursor && { next_cursor: result.next_cursor }),
        };
      } catch (error) {
        console.error("List notes tool error:", error);
        return {
          success: false,
          error: `Failed to list notes: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    toModelOutput({ output }) {
      const failure = errorText(output);
      if (failure) return { type: "text" as const, value: failure };
      return {
        type: "text" as const,
        value: renderNoteList(output as Parameters<typeof renderNoteList>[0]),
      };
    },
  });
};

/**
 * Read one owned note in full, in pages capped at an exact token budget.
 */
export const createGetNote = (context: ToolContext) =>
  tool({
    ...getNoteTool,
    execute: async ({ note_id, cursor }: GetNoteToolInput) => {
      const offset = cursor == null || cursor === "" ? 0 : Number(cursor);
      if (!Number.isInteger(offset) || offset < 0) {
        return { success: false, error: "Invalid cursor for this note" };
      }
      try {
        const result = await getNoteContent({
          userId: context.userID,
          noteId: note_id,
          offset,
        });
        if (!result.success || !result.note) {
          return {
            success: false,
            error: result.error || `Note '${note_id}' not found`,
          };
        }
        return { success: true, note: fitNotePage(result.note) };
      } catch (error) {
        console.error("Get note tool error:", error);
        return {
          success: false,
          error: `Failed to read note: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    toModelOutput({ output }) {
      const failure = errorText(output);
      if (failure) return { type: "text" as const, value: failure };
      return {
        type: "text" as const,
        value: renderNotePage((output as { note: NotePage }).note),
      };
    },
  });

/**
 * Update an existing note's title, content, or tags.
 */
export const createUpdateNote = (context: ToolContext, recall = false) => {
  const execute = async (input: UpdateNoteScopedToolInput) => {
    const { note_id, title, content, tags } = input;
    let observedAt: number | undefined;
    let recheckAfter: number | null | undefined;
    if (recall) {
      if (input.observed_at !== undefined) {
        const observed = parseObservedAt(input.observed_at, Date.now());
        if (!observed.ok) return { success: false, error: observed.error };
        observedAt = observed.value;
      }
      if (input.recheck_after === null) recheckAfter = null;
      else if (input.recheck_after !== undefined) {
        const recheck = parseRecheckAfter(input.recheck_after);
        if (!recheck.ok) return { success: false, error: recheck.error };
        recheckAfter = recheck.value;
      }
    }
    try {
      const result = await updateNote({
        userId: context.userID,
        noteId: note_id,
        title,
        content,
        tags,
        ...(recall && {
          target: input.target,
          observedAt,
          recheckAfter,
        }),
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error || "Failed to update note",
        };
      }

      return {
        success: true,
        message: `Note '${result.modified?.title || note_id}' updated successfully`,
        original: result.original,
        modified: result.modified,
      };
    } catch (error) {
      console.error("Update note tool error:", error);
      return {
        success: false,
        error: `Failed to update note: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  // Strip original/modified from model output (kept for UI only)
  const toModelOutput = ({ output }: { output: unknown }) => {
    if (typeof output === "object" && output !== null) {
      if ("error" in output) {
        return {
          type: "text" as const,
          value: `Error: ${(output as { error: string }).error}`,
        };
      }
      if ("message" in output) {
        return {
          type: "text" as const,
          value: (output as { message: string }).message,
        };
      }
    }
    return { type: "text" as const, value: JSON.stringify(output) };
  };
  return recall
    ? tool({ ...updateNoteScopedTool, execute, toModelOutput })
    : tool({ ...updateNoteTool, execute, toModelOutput });
};

/**
 * Delete a note by ID.
 */
export const createDeleteNote = (context: ToolContext) => {
  return tool({
    ...deleteNoteTool,
    execute: async ({ note_id }: DeleteNoteToolInput) => {
      try {
        const result = await deleteNote({
          userId: context.userID,
          noteId: note_id,
        });

        if (!result.success) {
          return {
            success: false,
            error: result.error || "Failed to delete note",
          };
        }

        return {
          success: true,
          message: `Note '${result.deleted_title || note_id}' deleted successfully`,
        };
      } catch (error) {
        console.error("Delete note tool error:", error);
        return {
          success: false,
          error: `Failed to delete note: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
};
