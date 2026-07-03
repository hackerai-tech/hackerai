import { tool } from "ai";
import type { ToolContext } from "@/types";
import {
  createNote,
  listNotes,
  updateNote,
  deleteNote,
} from "@/lib/db/actions";
import {
  createNoteTool,
  type CreateNoteToolInput,
  deleteNoteTool,
  type DeleteNoteToolInput,
  listNotesTool,
  type ListNotesToolInput,
  updateNoteTool,
  type UpdateNoteToolInput,
} from "./schemas";

/**
 * Create a new personal note to record observations, findings, or research.
 */
export const createCreateNote = (context: ToolContext) => {
  return tool({
    ...createNoteTool,
    execute: async ({
      title,
      content,
      category,
      tags,
    }: CreateNoteToolInput) => {
      try {
        const result = await createNote({
          userId: context.userID,
          title,
          content,
          category,
          tags,
        });

        if (!result.success) {
          return {
            success: false,
            error: result.error || "Failed to create note",
          };
        }

        return {
          success: true,
          note_id: result.note_id,
          message: `Note '${title}' created successfully`,
        };
      } catch (error) {
        console.error("Create note tool error:", error);
        return {
          success: false,
          error: `Failed to create note: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
};

/**
 * List and filter existing notes from the current engagement.
 */
export const createListNotes = (context: ToolContext) => {
  return tool({
    ...listNotesTool,
    execute: async ({ category, tags, search }: ListNotesToolInput) => {
      try {
        const result = await listNotes({
          userId: context.userID,
          category,
          tags,
          search,
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
};

/**
 * Update an existing note's title, content, or tags.
 */
export const createUpdateNote = (context: ToolContext) => {
  return tool({
    ...updateNoteTool,
    execute: async ({ note_id, title, content, tags }: UpdateNoteToolInput) => {
      try {
        const result = await updateNote({
          userId: context.userID,
          noteId: note_id,
          title,
          content,
          tags,
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
    },
    // Strip original/modified from model output (kept for UI only)
    toModelOutput({ output }) {
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
    },
  });
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
