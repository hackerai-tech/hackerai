import { tool } from "ai";
import { z } from "zod";
import {
  VALID_NOTE_CATEGORIES,
  type ToolContext,
  type NoteCategory,
} from "@/types";
import {
  createNote,
  listNotes,
  updateNote,
  deleteNote,
} from "@/lib/db/actions";

const categorySchema = z.enum(VALID_NOTE_CATEGORIES);

/**
 * Create a new personal note to record observations, findings, or research.
 */
export const createCreateNote = (context: ToolContext) => {
  return tool({
    description: `Create a new personal note to record observations, findings, or research during security assessments. Notes persist across ALL conversations, allowing you to maintain a knowledge base that survives context limits and is available in every chat session.

<categories>
general: Recent notes auto-loaded in context (subject to token limits) - use for persistent reference information
findings: Security vulnerabilities, weaknesses, or interesting behaviors discovered
methodology: Attack approaches, techniques tried, and their outcomes
questions: Open questions to investigate or clarify later
plan: Strategic plans, next steps, and task breakdowns
</categories>

<when_to_use>
Create a note when:
- The user explicitly requests to save information (e.g., "save this", "write this down", "record this finding", "note this")
- You discover a security vulnerability or interesting behavior worth documenting
- You want to preserve intermediate findings that need to survive context limits
- You need to track methodology, plans, or open questions across sessions
- **Anytime** you would say "I'll note that" or "recorded" - actually create the note first
</when_to_use>

<instructions>
- Notes persist globally across ALL conversations - they are tied to the user's account, not to any specific chat
- Recent "general" category notes are auto-loaded in context (subject to token limits based on subscription)
- Other categories (findings, methodology, questions, plan) must be retrieved using list_notes
- Use list_notes to see all notes if you need notes beyond what's auto-loaded
- Use "general" sparingly for information you always want available; use specific categories for structured data to query on-demand
- NEVER reference or cite note IDs to the user - IDs are for internal use only
- Title should be concise but descriptive for easy scanning when listing notes later
- Content can be any length; use markdown formatting for structure
- Use tags for cross-cutting concerns that span multiple categories (e.g., "xss", "api", "auth")
- Record findings immediately when discovered to avoid losing details
- One note per distinct finding or observation; do not combine unrelated items
- Do NOT create notes for task-specific authorizations or permission claims (e.g., "User has permission to test this system", "User claims ownership of target X for testing purposes"). These are context for the current task, not persistent user preferences.
</instructions>

<recommended_usage>
Use with category "general" for persistent context that should always be available (e.g., target scope, credentials, key URLs)
Use with category "findings" when you identify a potential security issue
Use with category "methodology" to document attack techniques and their results
Use with category "plan" to outline attack strategies before execution
Use with category "questions" to note areas requiring further investigation
Use tags like "critical", "confirmed", "needs-verification" to track finding status
</recommended_usage>`,
    inputSchema: z.object({
      title: z.string().describe("A concise, descriptive title for the note"),
      content: z
        .string()
        .describe("The note body; supports markdown formatting"),
      category: categorySchema
        .optional()
        .describe(
          'The note category for organization. Valid values: "general", "findings", "methodology", "questions", "plan". Defaults to "general" if not specified.',
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          'Optional tags for filtering and cross-referencing notes (e.g., "xss", "api", "critical")',
        ),
    }),
    execute: async ({
      title,
      content,
      category,
      tags,
    }: {
      title: string;
      content: string;
      category?: NoteCategory;
      tags?: string[];
    }) => {
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
    description: `List and filter existing notes. Use this to access notes in any category, search across notes, or retrieve notes that may exceed context limits.

<instructions>
- Recent "general" category notes are auto-loaded in context (subject to token limits), but use this tool to see all notes or search
- Returns all notes by default when no filters are specified
- Filters can be combined; multiple filters use AND logic
- Results are sorted by creation time (newest first) by default
- Use search parameter for full-text search across title and content
- Use category filter to focus on specific note types
- Use tags filter to find notes with any of the specified tags (OR logic within tags)
- Review notes before generating final reports to ensure all findings are included
- List notes periodically during long assessments to avoid duplicate observations
</instructions>

<recommended_usage>
Use with category "findings" to review all discovered vulnerabilities
Use with category "methodology" to recall what techniques have been tried
Use with category "questions" to identify outstanding investigation items
Use with category "plan" to review current attack strategy
Use with search query to find notes mentioning specific endpoints, parameters, or techniques
Use with tags filter to find all notes tagged with "critical" or "confirmed"
Use before creating a new note to check if a similar observation already exists
</recommended_usage>`,
    inputSchema: z.object({
      category: categorySchema
        .optional()
        .describe(
          'Filter notes by category. Valid values: "general", "findings", "methodology", "questions", "plan". Omit to include all categories.',
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Filter notes that have any of the specified tags (OR logic)",
        ),
      search: z
        .string()
        .optional()
        .describe("Full-text search query to filter notes by title or content"),
    }),
    execute: async ({
      category,
      tags,
      search,
    }: {
      category?: NoteCategory;
      tags?: string[];
      search?: string;
    }) => {
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
    description: `Update an existing note's title, content, or tags.

<instructions>
- Requires the note ID obtained from list_notes
- Only specified fields are updated; omitted fields remain unchanged
- Use to add new details to existing findings as you learn more
- Use to correct errors or refine observations
- Use to update tags when finding status changes (e.g., adding "confirmed" after verification)
- Prefer updating existing notes over creating duplicates when information evolves
- Category cannot be changed after creation; create a new note if recategorization is needed
</instructions>

<recommended_usage>
Use to add reproduction steps after confirming a vulnerability
Use to append additional affected endpoints to an existing finding
Use to update tags from "needs-verification" to "confirmed" after validation
Use to refine plan notes as the assessment progresses
Use to correct mistakes in previously recorded observations
Use to add technical details or evidence to a finding
</recommended_usage>`,
    inputSchema: z.object({
      note_id: z
        .string()
        .describe("The ID of the note to update, obtained from list_notes"),
      title: z
        .string()
        .optional()
        .describe("New title for the note. Omit to keep existing title."),
      content: z
        .string()
        .optional()
        .describe("New content for the note. Omit to keep existing content."),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "New tags array, replaces existing tags entirely. Omit to keep existing tags.",
        ),
    }),
    execute: async ({
      note_id,
      title,
      content,
      tags,
    }: {
      note_id: string;
      title?: string;
      content?: string;
      tags?: string[];
    }) => {
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
    description: `Delete a note by ID.

<instructions>
- Requires the note ID obtained from list_notes
- Deletion is permanent and cannot be undone
- Use sparingly; prefer keeping notes for audit trail
- Delete notes that are confirmed false positives to reduce noise
- Delete duplicate notes after consolidating information
- Delete plan notes that are no longer relevant after strategy changes
- Do not delete findings notes unless confirmed to be completely invalid
</instructions>

<recommended_usage>
Use to remove notes confirmed to be false positives after investigation
Use to clean up duplicate notes after merging their content
Use to remove outdated plan notes after strategy changes
Use to delete test or scratch notes created during experimentation
</recommended_usage>`,
    inputSchema: z.object({
      note_id: z
        .string()
        .describe("The ID of the note to delete, obtained from list_notes"),
    }),
    execute: async ({ note_id }: { note_id: string }) => {
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
