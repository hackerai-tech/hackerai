import { ShimmerText } from "./ShimmerText";
import { CodeHighlight } from "./CodeHighlight";
import { SquarePen } from "lucide-react";
import { ToolUIPart } from "ai";

interface ToolHandlerProps {
  part: ToolUIPart;
  toolName: string;
  status?: "ready" | "submitted" | "streaming" | "error";
}

export const ToolHandler = ({ part, toolName, status }: ToolHandlerProps) => {
  const { toolCallId, state, input, output } = part;

  const renderReadFileTool = () => {
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

  switch (toolName) {
    case "readFile":
      return renderReadFileTool();
    case "writeFile":
      return renderWriteFileTool();
    default:
      return null;
  }
};
