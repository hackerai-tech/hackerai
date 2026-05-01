import { memo, useMemo } from "react";
import ToolBlock from "@/components/ui/tool-block";
import { FileText, FilePlus, FilePen, FileOutput } from "lucide-react";
import type { ChatStatus } from "@/types";
import type { SidebarFile } from "@/types/chat";
import { isSidebarFile } from "@/types/chat";
import { useToolSidebar } from "../../hooks/useToolSidebar";

interface FileInput {
  action: "read" | "write" | "append" | "edit";
  path: string;
  brief: string;
  text?: string;
  range?: [number, number];
  edits?: Array<{ find: string; replace: string; all?: boolean }>;
}

interface FileHandlerProps {
  part: any;
  status: ChatStatus;
}

// Custom comparison for file handler - only re-render when state/output changes
function areFilePropsEqual(
  prev: FileHandlerProps,
  next: FileHandlerProps,
): boolean {
  if (prev.status !== next.status) return false;
  if (prev.part.state !== next.part.state) return false;
  if (prev.part.toolCallId !== next.part.toolCallId) return false;
  if (prev.part.output !== next.part.output) return false;
  if (prev.part.input !== next.part.input) return false;
  return true;
}

export const FileHandler = memo(function FileHandler({
  part,
  status,
}: FileHandlerProps) {
  const input = part.input as FileInput | undefined;
  const action = input?.action;

  const getFileRange = () => {
    if (!input?.range) return "";
    const [start, end] = input.range;
    if (end === -1) {
      return ` L${start}+`;
    }
    return ` L${start}-${end}`;
  };

  // Mirror the interactive-shell pattern: when the model supplies a `brief`
  // and the call didn't error, the brief stands alone as the block label
  // (no target path). Errors and pre-input states keep the verb + path so
  // failures still read clearly.
  const briefText = input?.brief?.trim() || "";
  const isOutputError =
    part.state === "output-available" &&
    typeof part.output === "object" &&
    part.output !== null &&
    "error" in part.output;
  const useBriefOnly = !!briefText && !isOutputError;
  const briefLabel = (fallback: string) =>
    useBriefOnly ? briefText : fallback;
  const briefTarget = (fallback: string | undefined) =>
    useBriefOnly ? undefined : fallback;

  // Compute sidebar content based on action and state
  const sidebarContent = useMemo((): SidebarFile | null => {
    if (!input?.path) return null;
    const toolCallId = part.toolCallId;

    // Write/Append during streaming — show content as it streams in
    if (
      (action === "write" || action === "append") &&
      (part.state === "input-streaming" || part.state === "input-available")
    ) {
      // During input-streaming, only show when content is available
      if (part.state === "input-streaming" && !input.text) return null;
      return {
        path: input.path,
        content: input.text || "",
        action: action === "append" ? "appending" : "creating",
        toolCallId,
        isExecuting: true,
      };
    }

    // Output available — build content from result
    if (part.state === "output-available") {
      const output = part.output;
      const isError =
        typeof output === "object" && output !== null && "error" in output;
      const errorMessage = isError
        ? (output as { error: string }).error
        : undefined;

      if (action === "read") {
        const cleanContent =
          !isError &&
          typeof output === "object" &&
          output !== null &&
          "originalContent" in output
            ? (output as { originalContent: string }).originalContent
            : "";
        const range = input.range
          ? {
              start: input.range[0],
              end: input.range[1] === -1 ? undefined : input.range[1],
            }
          : undefined;
        return {
          path: input.path,
          content: cleanContent,
          range,
          action: "reading",
          toolCallId,
          isExecuting: false,
          error: errorMessage,
        };
      }

      if (action === "write") {
        return {
          path: input.path,
          content: isError ? "" : input.text || "",
          action: "writing",
          toolCallId,
          isExecuting: false,
          error: errorMessage,
        };
      }

      if (action === "append") {
        const original =
          !isError &&
          typeof output === "object" &&
          output !== null &&
          "originalContent" in output
            ? (output.originalContent as string)
            : "";
        const modified =
          !isError &&
          typeof output === "object" &&
          output !== null &&
          "modifiedContent" in output
            ? (output.modifiedContent as string)
            : "";
        return {
          path: input.path,
          content: modified,
          action: "appending",
          toolCallId,
          originalContent: original,
          modifiedContent: modified,
          isExecuting: false,
          error: errorMessage,
        };
      }

      if (action === "edit") {
        const original =
          !isError &&
          typeof output === "object" &&
          output !== null &&
          "originalContent" in output
            ? (output.originalContent as string)
            : undefined;
        const modified =
          !isError &&
          typeof output === "object" &&
          output !== null &&
          "modifiedContent" in output
            ? (output.modifiedContent as string)
            : "";
        return {
          path: input.path,
          content: modified,
          action: "editing",
          toolCallId,
          originalContent: original,
          modifiedContent: modified,
          isExecuting: false,
          error: errorMessage,
        };
      }
    }

    return null;
  }, [action, part.state, part.output, input, part.toolCallId]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId: part.toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarFile,
  });

  const isClickable = !!sidebarContent;

  const renderReadAction = () => {
    const { toolCallId, state } = part;

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
            action={briefLabel("Reading")}
            target={briefTarget(
              input ? `${input.path}${getFileRange()}` : undefined,
            )}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        if (!input) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileText />}
            action={briefLabel(isOutputError ? `Failed to read` : "Read")}
            target={briefTarget(`${input.path}${getFileRange()}`)}
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

  const renderWriteAction = () => {
    const { toolCallId, state } = part;

    switch (state) {
      case "input-streaming": {
        const hasContent = !!input?.text;
        const hasFilePath = !!input?.path;

        if (status !== "streaming") return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action={briefLabel(hasContent ? "Creating" : "Creating file")}
            target={briefTarget(hasFilePath ? input.path : undefined)}
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
            action={briefLabel("Writing to")}
            target={briefTarget(input?.path)}
            isShimmer={true}
            isClickable={isClickable}
            onClick={isClickable ? handleOpenInSidebar : undefined}
            onKeyDown={isClickable ? handleKeyDown : undefined}
          />
        );
      case "output-available": {
        if (!input) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action={briefLabel(
              isOutputError ? "Failed to write" : "Successfully wrote",
            )}
            target={briefTarget(input.path)}
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

  const renderAppendAction = () => {
    const { toolCallId, state } = part;

    switch (state) {
      case "input-streaming": {
        const hasContent = !!input?.text;
        const hasFilePath = !!input?.path;

        if (status !== "streaming") return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileOutput />}
            action={briefLabel(hasContent ? "Appending to" : "Appending")}
            target={briefTarget(hasFilePath ? input.path : undefined)}
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
            icon={<FileOutput />}
            action={briefLabel("Appending to")}
            target={briefTarget(input?.path)}
            isShimmer={true}
            isClickable={isClickable}
            onClick={isClickable ? handleOpenInSidebar : undefined}
            onKeyDown={isClickable ? handleKeyDown : undefined}
          />
        );
      case "output-available": {
        if (!input) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileOutput />}
            action={briefLabel(
              isOutputError
                ? "Failed to append to"
                : "Successfully appended to",
            )}
            target={briefTarget(input.path)}
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

  const renderEditAction = () => {
    const { toolCallId, state } = part;

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
            action={briefLabel(
              input?.edits
                ? `Making ${input.edits.length} edit${input.edits.length > 1 ? "s" : ""} to`
                : "Editing",
            )}
            target={briefTarget(input?.path)}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        if (!input) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action={briefLabel(isOutputError ? "Failed to edit" : "Edited")}
            target={briefTarget(input.path)}
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

  // Route to the appropriate renderer based on action
  switch (action) {
    case "read":
      return renderReadAction();
    case "write":
      return renderWriteAction();
    case "append":
      return renderAppendAction();
    case "edit":
      return renderEditAction();
    default:
      return null;
  }
}, areFilePropsEqual);
