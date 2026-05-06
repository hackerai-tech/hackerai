/**
 * Workflow `"use step"` wrappers around the shared note impl in
 * `lib/ai/tools/utils/notes-impl.ts`. Both the AI-SDK note factories and
 * these steps return identical response shapes — the impl is the single
 * source of truth.
 */
import {
  createNoteImpl,
  listNotesImpl,
  updateNoteImpl,
  deleteNoteImpl,
} from "@/lib/ai/tools/utils/notes-impl";
import type { NoteCategory } from "@/types";

export async function createNoteStep(args: {
  userId: string;
  title: string;
  content: string;
  category?: NoteCategory;
  tags?: string[];
}) {
  "use step";
  return createNoteImpl(args);
}

export async function listNotesStep(args: {
  userId: string;
  category?: NoteCategory;
  tags?: string[];
  search?: string;
}) {
  "use step";
  return listNotesImpl(args);
}

export async function updateNoteStep(args: {
  userId: string;
  noteId: string;
  title?: string;
  content?: string;
  tags?: string[];
}) {
  "use step";
  return updateNoteImpl(args);
}

export async function deleteNoteStep(args: { userId: string; noteId: string }) {
  "use step";
  return deleteNoteImpl(args);
}
