import { UIMessage } from "@ai-sdk/react";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import DotsSpinner from "@/components/ui/dots-spinner";
import { ShimmerText } from "./ShimmerText";
import { TerminalCodeBlock } from "./TerminalCodeBlock";
import { CodeHighlight } from "./CodeHighlight";
import { SquarePen } from "lucide-react";
import { CommandResult } from "@e2b/code-interpreter";

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
  const renderTextPart = () => {
    const partId = `${message.id}-text-${partIndex}`;
    return (
      <MemoizedMarkdown
        key={partId}
        id={partId}
        content={part.text ?? ""}
      />
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
          <div key={toolCallId} className="text-muted-foreground">
            <ShimmerText>Reading file</ShimmerText>
          </div>
        ) : null;
      case "input-available":
        return status === "streaming" ? (
          <div key={toolCallId} className="text-muted-foreground">
            <ShimmerText>
              Reading {readInput.target_file}
              {getFileRange()}
            </ShimmerText>
          </div>
        ) : null;
      case "output-available": {
        const readOutput = output as { result: string };
        return (
          <div key={toolCallId} className="space-y-2">
            <div className="text-muted-foreground text-sm">
              Read {readInput.target_file}
              {getFileRange()}
            </div>
            <CodeHighlight
              className={`language-${readInput.target_file.split(".").pop() || "text"}`}
            >
              {readOutput.result.replace(/^\s*\d+\|/gm, "")}
            </CodeHighlight>
          </div>
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
          <div key={toolCallId} className="text-muted-foreground">
            <ShimmerText>Preparing to write file</ShimmerText>
          </div>
        ) : null;
      case "input-available":
        return (
          <div key={toolCallId} className="space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <SquarePen className="h-4 w-4" />
              <span>Writing to {writeInput.file_path}</span>
            </div>
            <CodeHighlight
              className={`language-${writeInput.file_path.split(".").pop() || "text"}`}
            >
              {writeInput.contents}
            </CodeHighlight>
          </div>
        );
      case "output-available":
        return (
          <div key={toolCallId} className="space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <SquarePen className="h-4 w-4" />
              <span>Successfully wrote {writeInput.file_path}</span>
            </div>
            <CodeHighlight
              className={`language-${writeInput.file_path.split(".").pop() || "text"}`}
            >
              {writeInput.contents}
            </CodeHighlight>
          </div>
        );
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
        const stdout = terminalOutput.result?.stdout ?? '';
        const stderr = terminalOutput.result?.stderr ?? '';
        const combinedOutput = stdout + stderr;
        const terminalOutputContent = combinedOutput || (terminalOutput.result?.error ?? '');
        
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

    case "data-terminal":
    case "tool-runTerminalCmd":
      return renderTerminalTool();

    default:
      return null;
  }
};
