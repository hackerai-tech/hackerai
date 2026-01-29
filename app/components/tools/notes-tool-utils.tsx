import { StickyNote, List, Pencil, Trash2 } from "lucide-react";

export type NotesToolName =
  | "create_note"
  | "list_notes"
  | "update_note"
  | "delete_note";

export type NotesActionType = "create" | "list" | "update" | "delete";

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
    default:
      return "list";
  }
};
