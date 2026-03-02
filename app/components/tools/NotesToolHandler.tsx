import { useMemo } from "react";
import ToolBlock from "@/components/ui/tool-block";
import type { ChatStatus, SidebarNote, SidebarNotes } from "@/types/chat";
import { isSidebarNotes } from "@/types/chat";
import { useToolSidebar } from "../../hooks/useToolSidebar";
import {
  getNotesIcon,
  getNotesStreamingActionText,
  getNotesActionText,
  getNotesActionType,
  type NotesToolName,
} from "./notes-tool-utils";

interface NotesToolHandlerProps {
  part: any;
  status: ChatStatus;
  toolName: NotesToolName;
}

export const NotesToolHandler = ({
  part,
  status,
  toolName,
}: NotesToolHandlerProps) => {
  const { toolCallId, state, input, output } = part;

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

  const sidebarContent = useMemo((): SidebarNotes | null => {
    const result = output || part.result;
    const action = getNotesActionType(toolName);

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
      notes = [
        {
          note_id: result?.note_id || "pending",
          title: input.title || "",
          content: input.content || "",
          category: input.category || "general",
          tags: input.tags || [],
          updated_at: 0,
        },
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
  }, [toolName, output, part.result, input, state, toolCallId]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarNotes,
  });

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={getNotesIcon(toolName, "h-4 w-4")}
          action={getNotesStreamingActionText(toolName)}
          isShimmer={true}
        />
      ) : null;

    case "input-available":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={getNotesIcon(toolName, "h-4 w-4")}
          action={getNotesStreamingActionText(toolName)}
          target={getTarget()}
          isShimmer={true}
        />
      ) : null;

    case "output-available": {
      const result = output || part.result;
      const isFailure = result?.success === false;

      if (isFailure) {
        return (
          <ToolBlock
            key={toolCallId}
            icon={getNotesIcon(toolName, "h-4 w-4")}
            action={getNotesActionText(toolName, true)}
            target={result?.error}
          />
        );
      }

      return (
        <ToolBlock
          key={toolCallId}
          icon={getNotesIcon(toolName, "h-4 w-4")}
          action={getNotesActionText(toolName)}
          target={getTarget()}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    }

    default:
      return null;
  }
};
