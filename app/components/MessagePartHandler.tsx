import { UIMessage } from "@ai-sdk/react";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { ShimmerText } from "./ShimmerText";
import { TerminalCodeBlock } from "./TerminalCodeBlock";
import ToolBlock from "@/components/ui/tool-block";
import { FilePlus, FileText, FilePen, FileMinus } from "lucide-react";
import { CommandResult } from "@e2b/code-interpreter";
import { useGlobalState } from "../contexts/GlobalState";

interface MessagePartHandlerProps {
  message: UIMessage;
  part: any;
  partIndex: number;
  status: "ready" | "submitted" | "streaming" | "error";
}

export const MessagePartHandler = ({
  message,
  part,
  partIndex,
  status,
}: MessagePartHandlerProps) => {
  const { openFileInSidebar } = useGlobalState();
  const renderTextPart = () => {
    const partId = `${message.id}-text-${partIndex}`;
    return (
      <MemoizedMarkdown key={partId} id={partId} content={part.text ?? ""} />
    );
  };

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

          openFileInSidebar({
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
              openFileInSidebar({
                path: writeInput.file_path,
                content: writeInput.contents,
                action: "writing",
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openFileInSidebar({
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
        const isSuccess = multiEditOutput.result.includes("Successfully applied");

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

  const renderTerminalTool = () => {
    const { toolCallId, state, input, output } = part;
    const terminalInput = input as {
      command: string;
      is_background: boolean;
    };
    const terminalOutput = output as { result: CommandResult };

    // Get terminal data parts specific to this tool call for streaming output
    const terminalDataParts = message.parts.filter(
      (p) =>
        p.type === "data-terminal" &&
        (p as any).data?.toolCallId === toolCallId,
    );
    const streamingOutput = terminalDataParts
      .map((p) => (p as any).data?.terminal || "")
      .join("");

    switch (state) {
      case "input-streaming":
        return status === "streaming" ? (
          <div key={toolCallId} className="text-muted-foreground">
            <ShimmerText>Generating command</ShimmerText>
          </div>
        ) : null;
      case "input-available":
        return (
          <TerminalCodeBlock
            key={toolCallId}
            command={terminalInput.command}
            output={streamingOutput}
            isExecuting={true}
            status={status}
          />
        );
      case "output-available": {
        const stdout = terminalOutput.result?.stdout ?? "";
        const stderr = terminalOutput.result?.stderr ?? "";
        const combinedOutput = stdout + stderr;
        const terminalOutputContent =
          combinedOutput || (terminalOutput.result?.error ?? "");

        return (
          <TerminalCodeBlock
            key={toolCallId}
            command={terminalInput.command}
            output={terminalOutputContent}
            status={status}
          />
        );
      }
      default:
        return null;
    }
  };

  // Main switch for different part types
  switch (part.type) {
    case "text":
      return renderTextPart();

    case "tool-readFile":
      return renderReadFileTool();

    case "tool-writeFile":
      return renderWriteFileTool();

    case "tool-deleteFile":
      return renderDeleteFileTool();

    case "tool-searchReplace":
      return renderSearchReplaceTool();

    case "tool-multiEdit":
      return renderMultiEditTool();

    case "data-terminal":
    case "tool-runTerminalCmd":
      return renderTerminalTool();

    default:
      return null;
  }
};
