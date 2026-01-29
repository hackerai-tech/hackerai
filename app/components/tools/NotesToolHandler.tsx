import ToolBlock from "@/components/ui/tool-block";
import { StickyNote, List, Pencil, Trash2 } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus, SidebarNote, SidebarNotes } from "@/types/chat";

interface NotesToolHandlerProps {
  part: any;
  status: ChatStatus;
  toolName: "create_note" | "list_notes" | "update_note" | "delete_note";
}

export const NotesToolHandler = ({
  part,
  status,
  toolName,
}: NotesToolHandlerProps) => {
  const { openSidebar } = useGlobalState();

  const { toolCallId, state, input, output } = part;

  const getIcon = () => {
    switch (toolName) {
      case "create_note":
        return <StickyNote className="h-4 w-4" />;
      case "list_notes":
        return <List className="h-4 w-4" />;
      case "update_note":
        return <Pencil className="h-4 w-4" />;
      case "delete_note":
        return <Trash2 className="h-4 w-4" />;
      default:
        return <StickyNote className="h-4 w-4" />;
    }
  };

  const getStreamingActionText = () => {
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

  const getActionText = () => {
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

  const getTarget = () => {
    if (toolName === "create_note" && input?.title) {
      return input.title;
    }
    if (toolName === "update_note" && input?.note_id) {
      return input.note_id;
    }
    if (toolName === "delete_note" && input?.note_id) {
      return input.note_id;
    }
    if (toolName === "list_notes") {
      const filters: string[] = [];
      if (input?.category) filters.push(input.category);
      if (input?.tags?.length) filters.push(`tagged: ${input.tags.join(", ")}`);
      if (input?.search) filters.push(`"${input.search}"`);
      return filters.length > 0 ? filters.join(" · ") : undefined;
    }
    return undefined;
  };

  const getActionType = (): SidebarNotes["action"] => {
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

  const buildSidebarContent = (): SidebarNotes => {
    const result = output || part.result;
    const action = getActionType();

    let notes: SidebarNote[] = [];
    let totalCount = 0;
    let affectedTitle: string | undefined;
    let newNoteId: string | undefined;
    let original: SidebarNotes["original"];
    let modified: SidebarNotes["modified"];

    if (action === "list" && result?.notes) {
      notes = result.notes;
      totalCount = result.total_count || notes.length;
    } else if (action === "create" && input) {
      // For create, show the created note
      notes = [
        {
          note_id: result?.note_id || "pending",
          title: input.title || "",
          content: input.content || "",
          category: input.category || "general",
          tags: input.tags || [],
          updated_at: Date.now(),
        },
      ];
      totalCount = 1;
      affectedTitle = input.title;
      newNoteId = result?.note_id;
    } else if (action === "update") {
      // For update, use original/modified for before/after comparison
      original = result?.original;
      modified = result?.modified;
      affectedTitle = modified?.title || input?.title || input?.note_id;
      totalCount = 1;
    } else if (action === "delete") {
      // For delete, show what was deleted
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
  };

  const handleOpenSidebar = () => {
    openSidebar(buildSidebarContent());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleOpenSidebar();
    }
  };

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={getIcon()}
          action={getStreamingActionText()}
          isShimmer={true}
        />
      ) : null;

    case "input-available":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={getIcon()}
          action={getStreamingActionText()}
          target={getTarget()}
          isShimmer={true}
        />
      ) : null;

    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={getIcon()}
          action={getActionText()}
          target={getTarget()}
          isClickable={true}
          onClick={handleOpenSidebar}
          onKeyDown={handleKeyDown}
        />
      );

    default:
      return null;
  }
};
