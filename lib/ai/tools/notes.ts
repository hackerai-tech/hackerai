import { tool } from "ai";
import { type ToolContext, type NoteCategory } from "@/types";
import {
  CREATE_NOTE_DESCRIPTION,
  CREATE_NOTE_INPUT_SCHEMA,
  LIST_NOTES_DESCRIPTION,
  LIST_NOTES_INPUT_SCHEMA,
  UPDATE_NOTE_DESCRIPTION,
  UPDATE_NOTE_INPUT_SCHEMA,
  DELETE_NOTE_DESCRIPTION,
  DELETE_NOTE_INPUT_SCHEMA,
} from "./schemas";
import {
  createNoteImpl,
  listNotesImpl,
  updateNoteImpl,
  deleteNoteImpl,
  updateNoteToModelOutput,
} from "./utils/notes-impl";

/**
 * Create a new personal note to record observations, findings, or research.
 */
export const createCreateNote = (context: ToolContext) =>
  tool({
    description: CREATE_NOTE_DESCRIPTION,
    inputSchema: CREATE_NOTE_INPUT_SCHEMA,
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
    }) =>
      createNoteImpl({
        userId: context.userID,
        title,
        content,
        category,
        tags,
      }),
  });

/**
 * List and filter existing notes from the current engagement.
 */
export const createListNotes = (context: ToolContext) =>
  tool({
    description: LIST_NOTES_DESCRIPTION,
    inputSchema: LIST_NOTES_INPUT_SCHEMA,
    execute: async ({
      category,
      tags,
      search,
    }: {
      category?: NoteCategory;
      tags?: string[];
      search?: string;
    }) => listNotesImpl({ userId: context.userID, category, tags, search }),
  });

/**
 * Update an existing note's title, content, or tags. The factory adds
 * `toModelOutput` to strip the original/modified diff payload from what
 * the model sees (kept in the return for the UI sidebar).
 */
export const createUpdateNote = (context: ToolContext) =>
  tool({
    description: UPDATE_NOTE_DESCRIPTION,
    inputSchema: UPDATE_NOTE_INPUT_SCHEMA,
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
    }) =>
      updateNoteImpl({
        userId: context.userID,
        noteId: note_id,
        title,
        content,
        tags,
      }),
    toModelOutput: updateNoteToModelOutput,
  });

/**
 * Delete a note by ID.
 */
export const createDeleteNote = (context: ToolContext) =>
  tool({
    description: DELETE_NOTE_DESCRIPTION,
    inputSchema: DELETE_NOTE_INPUT_SCHEMA,
    execute: async ({ note_id }: { note_id: string }) =>
      deleteNoteImpl({ userId: context.userID, noteId: note_id }),
  });
