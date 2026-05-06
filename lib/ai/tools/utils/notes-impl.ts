/**
 * Pure async wrappers around the Convex note actions in `lib/db/actions.ts`.
 * Both the AI-SDK factory in `lib/ai/tools/notes.ts` and the workflow step
 * in `lib/workflows/steps/notes-steps.ts` call into these so the
 * model-facing response shape stays in one place.
 */
import {
  createNote,
  listNotes,
  updateNote,
  deleteNote,
} from "@/lib/db/actions";
import type { NoteCategory } from "@/types";

type NoteResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | ({ success: true } & T)
  | { success: false; error: string };

export async function createNoteImpl(args: {
  userId: string;
  title: string;
  content: string;
  category?: NoteCategory;
  tags?: string[];
}): Promise<NoteResult<{ note_id?: string; message: string }>> {
  try {
    const result = await createNote({
      userId: args.userId,
      title: args.title,
      content: args.content,
      category: args.category,
      tags: args.tags,
    });
    if (!result.success) {
      return { success: false, error: result.error || "Failed to create note" };
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
      error: `Failed to create note: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function listNotesImpl(args: {
  userId: string;
  category?: NoteCategory;
  tags?: string[];
  search?: string;
}): Promise<
  NoteResult<{
    notes?: Awaited<ReturnType<typeof listNotes>>["notes"];
    total_count?: number;
  }>
> {
  try {
    const result = await listNotes({
      userId: args.userId,
      category: args.category,
      tags: args.tags,
      search: args.search,
    });
    if (!result.success) {
      return { success: false, error: result.error || "Failed to list notes" };
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
      error: `Failed to list notes: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function updateNoteImpl(args: {
  userId: string;
  noteId: string;
  title?: string;
  content?: string;
  tags?: string[];
}): Promise<
  NoteResult<{
    message: string;
    original?: Awaited<ReturnType<typeof updateNote>>["original"];
    modified?: Awaited<ReturnType<typeof updateNote>>["modified"];
  }>
> {
  try {
    const result = await updateNote({
      userId: args.userId,
      noteId: args.noteId,
      title: args.title,
      content: args.content,
      tags: args.tags,
    });
    if (!result.success) {
      return { success: false, error: result.error || "Failed to update note" };
    }
    return {
      success: true,
      message: `Note '${result.modified?.title ?? args.noteId}' updated successfully`,
      original: result.original,
      modified: result.modified,
    };
  } catch (error) {
    console.error("Update note tool error:", error);
    return {
      success: false,
      error: `Failed to update note: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Shared `toModelOutput` for the `update_note` tool — strips the
 * `original`/`modified` diff payload from what the model sees, keeping
 * only the human-readable message (or error). Used by both the AI-SDK
 * factory and the durable workflow tool.
 */
export function updateNoteToModelOutput({ output }: { output: unknown }): {
  type: "text";
  value: string;
} {
  if (typeof output === "object" && output !== null) {
    if ("error" in output) {
      return {
        type: "text",
        value: `Error: ${(output as { error: string }).error}`,
      };
    }
    if ("message" in output) {
      return {
        type: "text",
        value: (output as { message: string }).message,
      };
    }
  }
  return { type: "text", value: JSON.stringify(output) };
}

export async function deleteNoteImpl(args: {
  userId: string;
  noteId: string;
}): Promise<NoteResult<{ message: string }>> {
  try {
    const result = await deleteNote({
      userId: args.userId,
      noteId: args.noteId,
    });
    if (!result.success) {
      return { success: false, error: result.error || "Failed to delete note" };
    }
    return {
      success: true,
      message: `Note '${result.deleted_title || args.noteId}' deleted successfully`,
    };
  } catch (error) {
    console.error("Delete note tool error:", error);
    return {
      success: false,
      error: `Failed to delete note: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
