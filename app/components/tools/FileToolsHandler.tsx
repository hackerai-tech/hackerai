import ToolBlock from "@/components/ui/tool-block";
import { FilePlus, FileText, FilePen, FileMinus } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus } from "@/types";

interface FileToolsHandlerProps {
  part: any;
  status: ChatStatus;
}

export const FileToolsHandler = ({ part, status }: FileToolsHandlerProps) => {
  const { openSidebar } = useGlobalState();

  const renderReadFileTool = () => {
    const { toolCallId, state, input, output } = part;
    const readInput = input as {
      target_file: string;
      offset?: number;
      limit?: number;
    };

    const getFileRange = () => {
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
            target={`${readInput.target_file}${getFileRange()}`}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        const readOutput = output as { result: string };

        const handleOpenInSidebar = () => {
          const cleanContent = readOutput.result.replace(/^\s*\d+\|/gm, "");
          const range =
            readInput.offset && readInput.limit
              ? {
                  start: readInput.offset,
                  end: readInput.offset + readInput.limit - 1,
                }
              : undefined;

          openSidebar({
            path: readInput.target_file,
            content: cleanContent,
            range,
            action: "reading",
          });
        };

        const handleKeyDown = (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleOpenInSidebar();
          }
        };

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileText />}
            action="Read"
            target={`${readInput.target_file}${getFileRange()}`}
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

  const renderWriteFileTool = () => {
    const { toolCallId, state, input, output } = part;
    const writeInput = input as {
      file_path: string;
      contents: string;
    };

    switch (state) {
      case "input-streaming":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action="Creating file"
            isShimmer={true}
          />
        ) : null;
      case "input-available":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action="Writing to"
            target={writeInput.file_path}
            isShimmer={true}
          />
        ) : null;
      case "output-available":
        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action="Successfully wrote"
            target={writeInput.file_path}
            isClickable={true}
            onClick={() => {
              openSidebar({
                path: writeInput.file_path,
                content: writeInput.contents,
                action: "writing",
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openSidebar({
                  path: writeInput.file_path,
                  content: writeInput.contents,
                  action: "writing",
                });
              }
            }}
          />
        );
      default:
        return null;
    }
  };

  const renderDeleteFileTool = () => {
    const { toolCallId, state, input, output } = part;
    const deleteInput = input as {
      target_file: string;
      explanation: string;
    };

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
            target={deleteInput.target_file}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
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
    const searchReplaceInput = input as {
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    };

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
              searchReplaceInput.replace_all ? "Replacing all in" : "Editing"
            }
            target={searchReplaceInput.file_path}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        const searchReplaceOutput = output as { result: string };
        const isSuccess =
          searchReplaceOutput.result.includes("Successfully made");

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action={isSuccess ? "Successfully edited" : "Failed to edit"}
            target={searchReplaceInput.file_path}
          />
        );
      }
      default:
        return null;
    }
  };

  const renderMultiEditTool = () => {
    const { toolCallId, state, input, output } = part;
    const multiEditInput = input as {
      file_path: string;
      edits: Array<{
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      }>;
    };

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
            action={`Making ${multiEditInput.edits.length} edits to`}
            target={multiEditInput.file_path}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        const multiEditOutput = output as { result: string };
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
