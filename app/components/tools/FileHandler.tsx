import { memo, useMemo, type ReactNode } from "react";
import ToolBlock from "@/components/ui/tool-block";
import { Eye, FileText, FilePlus, FilePen, FileOutput } from "lucide-react";
import type { ChatStatus } from "@/types";
import type { SidebarFile } from "@/types/chat";
import { isSidebarFile } from "@/types/chat";
import type { FilePart } from "@/types/file";
import { useToolSidebar } from "../../hooks/useToolSidebar";
import { isUserStoppedToolError } from "@/lib/chat/tool-abort-utils";
import { ToolApprovalControls } from "./ToolApprovalControls";

interface FileInput {
  action: "view" | "read" | "write" | "append" | "edit";
  path: string;
  brief?: string;
  text?: string;
  range?: [number, number];
  edits?: Array<{ find: string; replace: string; all?: boolean }>;
}

interface FileHandlerProps {
  part: any;
  status: ChatStatus;
}

interface FileViewOutput {
  action?: "view";
  content?: string;
  filename?: string;
  mediaType?: string;
  sizeBytes?: number;
  kind?: "image" | "pdf";
  previewFiles?: Array<FilePart & { page?: number }>;
  renderedPages?: number[];
  renderedPageLimit?: number;
  truncatedPages?: boolean;
  pageCount?: number;
  previewError?: string;
  error?: string;
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
  if (prev.part.approval?.id !== next.part.approval?.id) return false;
  if (prev.part.errorText !== next.part.errorText) return false;
  if (prev.part.input !== next.part.input) return false;
  return true;
}

export const FileHandler = memo(function FileHandler({
  part,
  status,
}: FileHandlerProps) {
  const input = part.input as FileInput | undefined;
  const action = input?.action;
  const outputErrorText =
    typeof part.errorText === "string" ? part.errorText : undefined;
  const isIncompleteState =
    part.state === "input-streaming" || part.state === "input-available";
  const isStoppedIncomplete = isIncompleteState && status !== "streaming";

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
    isStoppedIncomplete ||
    part.state === "output-error" ||
    (part.state === "output-available" &&
      typeof part.output === "object" &&
      part.output !== null &&
      "error" in part.output);
  const isStoppedByUser =
    isStoppedIncomplete || isUserStoppedToolError(outputErrorText);
  const useBriefOnly = !!briefText && !isOutputError;
  const briefLabel = (fallback: string) =>
    useBriefOnly ? briefText : fallback;
  const briefTarget = (fallback: string | undefined) =>
    useBriefOnly ? undefined : fallback;
  const errorLabel = (failed: string, stopped: string) =>
    isStoppedByUser ? stopped : failed;

  // Compute sidebar content based on action and state
  const sidebarContent = useMemo((): SidebarFile | null => {
    if (!input?.path) return null;
    const toolCallId = part.toolCallId;

    // Write/Append during streaming — show content as it streams in
    if (part.state === "input-streaming" || part.state === "input-available") {
      if (action === "view") {
        return {
          path: input.path,
          content: "",
          action: "viewing",
          toolCallId,
          isExecuting: true,
        };
      }

      if (action !== "write" && action !== "append") return null;
      // During input-streaming, only show when content is available
      if (part.state === "input-streaming" && !input.text) return null;
      return {
        path: input.path,
        content: input.text || "",
        action: action === "append" ? "appending" : "creating",
        toolCallId,
        isExecuting: status === "streaming",
      };
    }

    // Output available — build content from result
    if (part.state === "output-available" || part.state === "output-error") {
      const output = part.output;
      const isError =
        part.state === "output-error" ||
        (typeof output === "object" && output !== null && "error" in output);
      const errorMessage = isError
        ? outputErrorText || (output as { error: string } | undefined)?.error
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

      if (action === "view") {
        const viewOutput =
          !isError && typeof output === "object" && output !== null
            ? (output as FileViewOutput)
            : undefined;

        return {
          path: input.path,
          content: viewOutput?.content || "",
          action: "viewing",
          toolCallId,
          isExecuting: false,
          error: errorMessage,
          filename: viewOutput?.filename,
          mediaType: viewOutput?.mediaType,
          sizeBytes: viewOutput?.sizeBytes,
          kind: viewOutput?.kind,
          previewFiles: viewOutput?.previewFiles,
          renderedPages: viewOutput?.renderedPages,
          renderedPageLimit: viewOutput?.renderedPageLimit,
          truncatedPages: viewOutput?.truncatedPages,
          pageCount: viewOutput?.pageCount,
          previewError: viewOutput?.previewError,
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
  }, [
    action,
    part.state,
    part.output,
    input,
    part.toolCallId,
    outputErrorText,
    status,
  ]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId: part.toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarFile,
  });

  const isClickable = !!sidebarContent;
  const renderApprovalRequest = ({
    icon,
    target,
  }: {
    icon: ReactNode;
    target?: string;
  }) => (
    <div key={part.toolCallId}>
      <ToolBlock
        icon={icon}
        action="Approval required"
        target={target}
        isShimmer={status === "streaming"}
        isClickable={isClickable}
        onClick={isClickable ? handleOpenInSidebar : undefined}
        onKeyDown={isClickable ? handleKeyDown : undefined}
      />
      <ToolApprovalControls
        approvalId={part.approval?.id}
        toolCallId={part.toolCallId}
      />
    </div>
  );

  const renderViewAction = () => {
    const { toolCallId, state } = part;

    switch (state) {
      case "input-streaming":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<Eye />}
            action="Viewing file"
            isShimmer={true}
          />
        ) : null;
      case "input-available":
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<Eye />}
            action={briefLabel("Viewing")}
            target={briefTarget(input?.path)}
            isShimmer={true}
            isClickable={isClickable}
            onClick={isClickable ? handleOpenInSidebar : undefined}
            onKeyDown={isClickable ? handleKeyDown : undefined}
          />
        ) : null;
      case "output-available": {
        if (!input) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<Eye />}
            action={briefLabel(isOutputError ? "Failed to view" : "Viewed")}
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

  const renderReadAction = () => {
    const { toolCallId, state } = part;

    switch (state) {
      case "input-streaming":
        if (isStoppedIncomplete && input?.path) {
          return (
            <ToolBlock
              key={toolCallId}
              icon={<FileText />}
              action="Stopped reading"
              target={`${input.path}${getFileRange()}`}
            />
          );
        }
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FileText />}
            action="Reading file"
            isShimmer={true}
          />
        ) : null;
      case "input-available":
        if (isStoppedIncomplete && input?.path) {
          return (
            <ToolBlock
              key={toolCallId}
              icon={<FileText />}
              action="Stopped reading"
              target={`${input.path}${getFileRange()}`}
            />
          );
        }
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
      case "output-available":
      case "output-error": {
        if (!input) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileText />}
            action={briefLabel(
              isOutputError
                ? errorLabel("Failed to read", "Stopped reading")
                : "Read",
            )}
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

        if (status !== "streaming") {
          if (!hasFilePath) return null;
          return (
            <ToolBlock
              key={toolCallId}
              icon={<FilePlus />}
              action="Stopped writing"
              target={input.path}
              isClickable={isClickable}
              onClick={isClickable ? handleOpenInSidebar : undefined}
              onKeyDown={isClickable ? handleKeyDown : undefined}
            />
          );
        }

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
        if (status !== "streaming") {
          if (!input?.path) return null;
          return (
            <ToolBlock
              key={toolCallId}
              icon={<FilePlus />}
              action="Stopped writing"
              target={input.path}
              isClickable={isClickable}
              onClick={isClickable ? handleOpenInSidebar : undefined}
              onKeyDown={isClickable ? handleKeyDown : undefined}
            />
          );
        }
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
      case "approval-requested":
        return renderApprovalRequest({
          icon: <FilePlus />,
          target: input?.path,
        });
      case "output-available":
      case "output-error": {
        if (!input) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action={briefLabel(
              isOutputError
                ? errorLabel("Failed to write", "Stopped writing")
                : "Successfully wrote",
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

        if (status !== "streaming") {
          if (!hasFilePath) return null;
          return (
            <ToolBlock
              key={toolCallId}
              icon={<FileOutput />}
              action="Stopped appending to"
              target={input.path}
              isClickable={isClickable}
              onClick={isClickable ? handleOpenInSidebar : undefined}
              onKeyDown={isClickable ? handleKeyDown : undefined}
            />
          );
        }

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
        if (status !== "streaming") {
          if (!input?.path) return null;
          return (
            <ToolBlock
              key={toolCallId}
              icon={<FileOutput />}
              action="Stopped appending to"
              target={input.path}
              isClickable={isClickable}
              onClick={isClickable ? handleOpenInSidebar : undefined}
              onKeyDown={isClickable ? handleKeyDown : undefined}
            />
          );
        }
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
      case "approval-requested":
        return renderApprovalRequest({
          icon: <FileOutput />,
          target: input?.path,
        });
      case "output-available":
      case "output-error": {
        if (!input) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileOutput />}
            action={briefLabel(
              isOutputError
                ? errorLabel("Failed to append to", "Stopped appending to")
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
        if (isStoppedIncomplete && input?.path) {
          return (
            <ToolBlock
              key={toolCallId}
              icon={<FilePen />}
              action="Stopped editing"
              target={input.path}
            />
          );
        }
        return status === "streaming" ? (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action="Editing file"
            isShimmer={true}
          />
        ) : null;
      case "input-available":
        if (isStoppedIncomplete && input?.path) {
          return (
            <ToolBlock
              key={toolCallId}
              icon={<FilePen />}
              action="Stopped editing"
              target={input.path}
            />
          );
        }
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
      case "approval-requested":
        return renderApprovalRequest({
          icon: <FilePen />,
          target: input?.path,
        });
      case "output-available":
      case "output-error": {
        if (!input) return null;

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePen />}
            action={briefLabel(
              isOutputError
                ? errorLabel("Failed to edit", "Stopped editing")
                : "Edited",
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

  // Route to the appropriate renderer based on action
  switch (action) {
    case "view":
      return renderViewAction();
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
