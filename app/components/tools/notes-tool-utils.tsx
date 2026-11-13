import { StickyNote, List, Pencil, Trash2, FileText } from "lucide-react";
import type { NoteCategory, SidebarNote, SidebarNotes } from "@/types/chat";

export type NotesToolName =
  "create_note" | "list_notes" | "update_note" | "delete_note" | "get_note";

export type NotesActionType = SidebarNotes["action"];

export const NOTES_TOOL_NAMES: readonly NotesToolName[] = [
  "create_note",
  "list_notes",
  "update_note",
  "delete_note",
  "get_note",
];

export const getNotesIcon = (toolName: NotesToolName, className?: string) => {
  const props = className ? { className } : {};
  switch (toolName) {
    case "create_note":
      return <StickyNote aria-hidden="true" {...props} />;
    case "list_notes":
      return <List aria-hidden="true" {...props} />;
    case "update_note":
      return <Pencil aria-hidden="true" {...props} />;
    case "delete_note":
      return <Trash2 aria-hidden="true" {...props} />;
    case "get_note":
      return <FileText aria-hidden="true" {...props} />;
    default:
      return <StickyNote aria-hidden="true" {...props} />;
  }
};

export const getNotesStreamingActionText = (
  toolName: NotesToolName,
): string => {
  switch (toolName) {
    case "create_note":
      return "Creating note";
    case "list_notes":
      return "Listing notes";
    case "update_note":
      return "Updating note";
    case "delete_note":
      return "Deleting note";
    case "get_note":
      return "Reading note";
    default:
      return "Processing note";
  }
};

export const getNotesActionText = (
  toolName: NotesToolName,
  isFailure = false,
): string => {
  if (isFailure) {
    switch (toolName) {
      case "create_note":
        return "Failed to create note";
      case "list_notes":
        return "Failed to list notes";
      case "update_note":
        return "Failed to update note";
      case "delete_note":
        return "Failed to delete note";
      case "get_note":
        return "Failed to read note";
      default:
        return "Note action failed";
    }
  }
  switch (toolName) {
    case "create_note":
      return "Created note";
    case "list_notes":
      return "Listed notes";
    case "update_note":
      return "Updated note";
    case "delete_note":
      return "Deleted note";
    case "get_note":
      return "Read note";
    default:
      return "Note action";
  }
};

export const getNotesActionType = (
  toolName: NotesToolName,
): NotesActionType => {
  switch (toolName) {
    case "create_note":
      return "create";
    case "list_notes":
      return "list";
    case "update_note":
      return "update";
    case "delete_note":
      return "delete";
    case "get_note":
      return "get";
    default:
      return "list";
  }
};

type RawNote = Partial<SidebarNote> & {
  preview?: string;
  next_cursor?: string;
  content_offset?: number;
};

/** Legacy outputs carry full content; recall outputs carry a preview. */
const toSidebarNote = (note: RawNote): SidebarNote => ({
  note_id: note.note_id ?? "",
  title: note.title ?? "",
  content: note.content ?? note.preview ?? "",
  category: (note.category ?? "general") as NoteCategory,
  tags: Array.isArray(note.tags) ? note.tags : [],
  updated_at: note.updated_at ?? 0,
  ...(note.target && { target: note.target }),
  ...(note.observed_at !== undefined && { observed_at: note.observed_at }),
  ...(note.recheck && { recheck: note.recheck }),
  ...(note.preview_truncated && { preview_truncated: true }),
  // Any page of a multi-page note: a later page has an offset, earlier a cursor.
  ...((note.next_cursor || (note.content_offset ?? 0) > 0) && {
    partial_content: true,
  }),
});

/**
 * Sidebar content for one notes tool part. Shared by the inline tool block
 * and the sidebar timeline so saved messages render the same everywhere.
 */
export function buildNotesSidebarContent({
  toolName,
  input,
  output,
  state,
  toolCallId,
}: {
  toolName: NotesToolName;
  input: any;
  output: any;
  state?: string;
  toolCallId?: string;
}): SidebarNotes {
  const result = output?.result || output || {};
  const action = getNotesActionType(toolName);

  let notes: SidebarNote[] = [];
  let totalCount = 0;
  let affectedTitle: string | undefined;
  let newNoteId: string | undefined;
  let original: SidebarNotes["original"];
  let modified: SidebarNotes["modified"];

  if (action === "list" && Array.isArray(result?.notes)) {
    notes = result.notes.map(toSidebarNote);
    totalCount = result.total_count || notes.length;
  } else if (action === "get") {
    notes = result?.note ? [toSidebarNote(result.note)] : [];
    affectedTitle = result?.note?.title || input?.note_id;
    totalCount = notes.length;
  } else if (action === "create" && input) {
    notes = [
      toSidebarNote({
        note_id: result?.note_id || "pending",
        title: input.title || "",
        content: input.content || "",
        category: input.category || "general",
        tags: input.tags || [],
        updated_at: 0,
        target: typeof input.target === "string" ? input.target : undefined,
      }),
    ];
    totalCount = 1;
    affectedTitle = input.title;
    newNoteId = result?.note_id;
  } else if (action === "update") {
    original = result?.original;
    modified = result?.modified;
    affectedTitle = modified?.title || input?.title || input?.note_id;
    totalCount = 1;
  } else if (action === "delete") {
    affectedTitle = result?.deleted_title || input?.note_id;
    totalCount = 0;
  }

  return {
    action,
    notes,
    totalCount,
    isExecuting: state !== "output-available",
    toolCallId: toolCallId || "",
    affectedTitle,
    newNoteId,
    original,
    modified,
  };
}

// Date-only observations are stored at UTC midnight. Use the same UTC date
// as the model-facing metadata so local timezones cannot shift the evidence day.
const formatNoteDate = (value: number) =>
  new Date(value).toISOString().slice(0, 10);

const sameDay = (a: number, b: number) =>
  formatNoteDate(a) === formatNoteDate(b);

/**
 * Inline metadata segments: target, observation date and edit date. Missing
 * observation dates on observations are stated rather than inferred.
 * Returns nothing for legacy notes so old saved outputs look unchanged.
 */
export function getNoteMetaSegments(note: SidebarNote): string[] {
  const isRecall =
    note.target !== undefined ||
    note.observed_at !== undefined ||
    note.recheck !== undefined;
  if (!isRecall) return [];
  return [
    note.target ?? (note.category === "general" ? "All targets" : undefined),
    note.observed_at !== undefined
      ? `Observed ${formatNoteDate(note.observed_at)}`
      : "Observed date unknown",
    note.recheck === "recheck_due" ? "Recheck due" : undefined,
    note.updated_at > 0 &&
    (note.observed_at === undefined ||
      !sameDay(note.observed_at, note.updated_at))
      ? `Edited ${formatNoteDate(note.updated_at)}`
      : undefined,
  ].filter((segment): segment is string => Boolean(segment));
}
