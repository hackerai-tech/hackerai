import { memo, useMemo } from "react";
import ToolBlock from "@/components/ui/tool-block";
import type { ChatStatus, SidebarNotes } from "@/types/chat";
import { isSidebarNotes } from "@/types/chat";
import { useToolSidebar } from "../../hooks/useToolSidebar";
import { isUserStoppedToolError } from "@/lib/chat/tool-abort-utils";
import {
  buildNotesSidebarContent,
  getNotesIcon,
  getNotesStreamingActionText,
  getNotesActionText,
  type NotesToolName,
} from "./notes-tool-utils";

interface NotesToolHandlerProps {
  part: any;
  status: ChatStatus;
  toolName: NotesToolName;
}

export const NotesToolHandler = memo(function NotesToolHandler({
  part,
  status,
  toolName,
}: NotesToolHandlerProps) {
  const { toolCallId, state, input, output, errorText } = part;
  const isStoppedByUser = isUserStoppedToolError(errorText);
  const stoppedActionText = () => {
    switch (toolName) {
      case "create_note":
        return "Stopped creating note";
      case "list_notes":
        return "Stopped listing notes";
      case "update_note":
        return "Stopped updating note";
      case "delete_note":
        return "Stopped deleting note";
      case "get_note":
        return "Stopped reading note";
      default:
        return "Stopped note action";
    }
  };

  const getTarget = () => {
    if (toolName === "create_note" && input?.title) {
      return input.title;
    }
    if (toolName === "get_note") {
      const result = output || part.result;
      return result?.note?.title || input?.note_id;
    }
    if (toolName === "update_note" && input?.note_id) {
      return input.note_id;
    }
    if (toolName === "delete_note" && input?.note_id) {
      return input.note_id;
    }
    if (toolName === "list_notes") {
      const filters: string[] = [];
      if (typeof input?.target === "string" && input.target)
        filters.push(input.target);
      if (input?.category) filters.push(input.category);
      if (input?.tags?.length) filters.push(`tagged: ${input.tags.join(", ")}`);
      if (input?.search) filters.push(`"${input.search}"`);
      return filters.length > 0 ? filters.join(" · ") : undefined;
    }
    return undefined;
  };

  const sidebarContent = useMemo(
    (): SidebarNotes | null =>
      buildNotesSidebarContent({
        toolName,
        input,
        output: output || part.result,
        state,
        toolCallId,
      }),
    [toolName, output, part.result, input, state, toolCallId],
  );

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

    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={getNotesIcon(toolName, "h-4 w-4")}
          action={
            isStoppedByUser
              ? stoppedActionText()
              : getNotesActionText(toolName, true)
          }
          target={getTarget()}
        />
      );

    default:
      return null;
  }
});
