import { useMemo } from "react";
import { UIMessage } from "@ai-sdk/react";
import ToolBlock from "@/components/ui/tool-block";
import { FilePlus, FileText, FilePen, FileMinus } from "lucide-react";
import type { ChatStatus } from "@/types";
import type { SidebarFile } from "@/types/chat";
import { isSidebarFile } from "@/types/chat";
import { useToolSidebar } from "../../hooks/useToolSidebar";

interface DiffDataPart {
  type: "data-diff";
  data: {
    toolCallId: string;
    filePath: string;
    originalContent: string;
    modifiedContent: string;
  };
}

interface FileToolsHandlerProps {
  message: UIMessage;
  part: any;
  status: ChatStatus;
}

export const FileToolsHandler = ({
  message,
  part,
  status,
}: FileToolsHandlerProps) => {
  // Extract diff data from data-diff parts in the message (streamed separately from tool result)
  const diffDataFromStream = useMemo(() => {
    if (part.type !== "tool-search_replace") return null;

    const diffPart = message.parts.find(
      (p): p is DiffDataPart =>
        p.type === "data-diff" &&
        (p as DiffDataPart).data?.toolCallId === part.toolCallId,
    );

    return diffPart?.data || null;
  }, [message.parts, part.type, part.toolCallId]);

  // Compute sidebar content based on tool type and state
  const sidebarContent = useMemo((): SidebarFile | null => {
    const { type, toolCallId, state, input, output } = part;

    // write_file during streaming — show content as it streams in
    if (
      type === "tool-write_file" &&
      (state === "input-streaming" || state === "input-available")
    ) {
      const writeInput = input as
        | { file_path: string; contents: string }
        | undefined;
      if (!writeInput?.file_path) return null;
      if (state === "input-streaming" && !writeInput.contents) return null;
      return {
        path: writeInput.file_path,
        content: writeInput.contents || "",
        action: "creating",
        toolCallId,
        isExecuting: true,
      };
    }

    // Output available — build content from result
    if (state !== "output-available") return null;

    if (type === "tool-read_file") {
      const readInput = input as
        | { target_file: string; offset?: number; limit?: number }
        | undefined;
      if (!readInput) return null;
      const readOutput = output as { result: string };
      const cleanContent = readOutput?.result?.replace(/^\s*\d+\|/gm, "") || "";
      const range =
        readInput.offset && readInput.limit
          ? {
              start: readInput.offset,
              end: readInput.offset + readInput.limit - 1,
            }
          : undefined;
      return {
        path: readInput.target_file,
        content: cleanContent,
        range,
        action: "reading",
        toolCallId,
        isExecuting: false,
      };
    }

    if (type === "tool-write_file") {
      const writeInput = input as
        | { file_path: string; contents: string }
        | undefined;
      if (!writeInput) return null;
      return {
        path: writeInput.file_path,
        content: writeInput.contents,
        action: "writing",
        toolCallId,
        isExecuting: false,
      };
    }

    if (type === "tool-search_replace") {
      const searchReplaceInput = input as
        | {
            file_path: string;
            old_string: string;
            new_string: string;
            replace_all?: boolean;
          }
        | undefined;
      if (!searchReplaceInput) return null;
      const searchReplaceOutput = output as { result: string };
      return {
        path: searchReplaceInput.file_path,
        content:
          diffDataFromStream?.modifiedContent ||
          searchReplaceOutput?.result ||
          "",
        action: "editing",
        toolCallId,
        originalContent: diffDataFromStream?.originalContent,
        modifiedContent: diffDataFromStream?.modifiedContent,
        isExecuting: false,
      };
    }

    if (type === "tool-multi_edit") {
      const multiEditInput = input as
        | {
            file_path: string;
            edits: Array<{
              old_string: string;
              new_string: string;
              replace_all?: boolean;
            }>;
          }
        | undefined;
      if (!multiEditInput) return null;
      return {
        path: multiEditInput.file_path,
        content: "",
        action: "editing",
        toolCallId,
        isExecuting: false,
      };
    }

    return null;
  }, [
    part.type,
    part.state,
    part.toolCallId,
    part.input,
    part.output,
    diffDataFromStream,
  ]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId: part.toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarFile,
  });

  const isClickable = !!sidebarContent;

  const renderReadFileTool = () => {
    const { toolCallId, state, input } = part;
    const readInput = input as
      | { target_file: string; offset?: number; limit?: number }
      | undefined;

    const getFileRange = () => {
      if (!readInput) return "";
      if (readInput.offset && readInput.limit) {
        return ` L${readInput.offset}-${readInput.offset + readInput.limit - 1}`;
      }
      if (!readInput.offset && readInput.limit) {
        return ` L1-${readInput.limit}`;
      }
      if (readInput.offset && !readInput.limit) {
        return ` L${readInput.offset}+`;
      }
      return "";
    };

    switch (state) {
      case "input-streaming":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FileText />}
            action="Reading file"
            isShimmer={true}
          />
        ) : null;
      case "input-available":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FileText />}
            action="Reading"
            target={
              readInput
                ? `${readInput.target_file}${getFileRange()}`
                : undefined
            }
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        if (!readInput) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileText />}
            action="Read"
            target={`${readInput.target_file}${getFileRange()}`}
            isClickable={isClickable}
            onClick={handleOpenInSidebar}
            onKeyDown={handleKeyDown}
          />
        );
      }
      default:
        return null;
    }
  };

  const renderWriteFileTool = () => {
    const { toolCallId, state, input } = part;
    const writeInput = input as
      | { file_path: string; contents: string }
      | undefined;

    switch (state) {
      case "input-streaming": {
        const hasContent = !!writeInput?.contents;
        const hasFilePath = !!writeInput?.file_path;

        if (status !== "streaming") return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action={hasContent ? "Creating" : "Creating file"}
            target={hasFilePath ? writeInput.file_path : undefined}
            isShimmer={true}
            isClickable={isClickable}
            onClick={isClickable ? handleOpenInSidebar : undefined}
            onKeyDown={isClickable ? handleKeyDown : undefined}
          />
        );
      }
      case "input-available":
        if (status !== "streaming") return null;
        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action="Writing to"
            target={writeInput?.file_path}
            isShimmer={true}
            isClickable={isClickable}
            onClick={isClickable ? handleOpenInSidebar : undefined}
            onKeyDown={isClickable ? handleKeyDown : undefined}
          />
        );
      case "output-available":
        if (!writeInput) return null;
        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action="Successfully wrote"
            target={writeInput.file_path}
            isClickable={isClickable}
            onClick={handleOpenInSidebar}
            onKeyDown={handleKeyDown}
          />
        );
      default:
        return null;
    }
  };

  const renderDeleteFileTool = () => {
    const { toolCallId, state, input, output } = part;
    const deleteInput = input as
      | { target_file: string; explanation: string }
      | undefined;

    switch (state) {
      case "input-streaming":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FileMinus />}
            action="Deleting file"
            isShimmer={true}
          />
        ) : null;
      case "input-available":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FileMinus />}
            action="Deleting"
            target={deleteInput?.target_file}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        if (!deleteInput) return null;
        const deleteOutput = output as { result: string };
        const isSuccess = deleteOutput.result.includes("Successfully deleted");

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileMinus />}
            action={isSuccess ? "Successfully deleted" : "Failed to delete"}
            target={deleteInput.target_file}
          />
        );
      }
      default:
        return null;
    }
  };

  const renderSearchReplaceTool = () => {
    const { toolCallId, state, input, output } = part;
    const searchReplaceInput = input as
      | {
          file_path: string;
          old_string: string;
          new_string: string;
          replace_all?: boolean;
        }
      | undefined;

    switch (state) {
      case "input-streaming":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action="Editing file"
            isShimmer={true}
          />
        ) : null;
      case "input-available":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action={
              searchReplaceInput?.replace_all ? "Replacing all in" : "Editing"
            }
            target={searchReplaceInput?.file_path}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        if (!searchReplaceInput) return null;
        const searchReplaceOutput = output as { result: string };
        const isSuccess =
          searchReplaceOutput.result.includes("Successfully made");

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action={isSuccess ? "Successfully edited" : "Failed to edit"}
            target={searchReplaceInput.file_path}
            isClickable={isClickable}
            onClick={handleOpenInSidebar}
            onKeyDown={handleKeyDown}
          />
        );
      }
      default:
        return null;
    }
  };

  const renderMultiEditTool = () => {
    const { toolCallId, state, input } = part;
    const multiEditInput = input as
      | {
          file_path: string;
          edits: Array<{
            old_string: string;
            new_string: string;
            replace_all?: boolean;
          }>;
        }
      | undefined;

    switch (state) {
      case "input-streaming":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action="Making multiple edits"
            isShimmer={true}
          />
        ) : null;
      case "input-available":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action={
              multiEditInput
                ? `Making ${multiEditInput.edits.length} edits to`
                : "Making edits"
            }
            target={multiEditInput?.file_path}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        if (!multiEditInput) return null;
        const multiEditOutput = part.output as { result: string };
        const isSuccess = multiEditOutput.result.includes(
          "Successfully applied",
        );

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action={
              isSuccess
                ? `Successfully applied ${multiEditInput.edits.length} edits`
                : "Failed to apply edits"
            }
            target={multiEditInput.file_path}
          />
        );
      }
      default:
        return null;
    }
  };

  // Main switch for file tool types
  switch (part.type) {
    case "tool-read_file":
      return renderReadFileTool();
    case "tool-write_file":
      return renderWriteFileTool();
    case "tool-delete_file":
      return renderDeleteFileTool();
    case "tool-search_replace":
      return renderSearchReplaceTool();
    case "tool-multi_edit":
      return renderMultiEditTool();
    default:
      return null;
  }
};
