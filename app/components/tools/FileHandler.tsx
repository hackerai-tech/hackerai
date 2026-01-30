import { memo, useMemo, useEffect, useRef, useCallback } from "react";
import ToolBlock from "@/components/ui/tool-block";
import { FileText, FilePlus, FilePen, FileOutput } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus } from "@/types";
import { isSidebarFile } from "@/types/chat";

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
  const { openSidebar, updateSidebarContent, sidebarContent, sidebarOpen } =
    useGlobalState();

  // Track the last streamed content to avoid unnecessary updates
  const lastStreamedContentRef = useRef<string | null>(null);
  // Track if this tool opened the sidebar (to know when to update it)
  const isOwnSidebarRef = useRef(false);

  const input = part.input as FileInput | undefined;
  const action = input?.action;

  // Extract streaming write content for write/append actions
  const writeStreamingContent = useMemo(() => {
    if (action !== "write" && action !== "append") return null;
    return input?.text || null;
  }, [action, input?.text]);

  // Update sidebar content as write/append content streams in
  useEffect(() => {
    if (action !== "write" && action !== "append") return;
    if (part.state !== "input-streaming" && part.state !== "input-available")
      return;
    if (!writeStreamingContent) return;
    if (!sidebarOpen || !isOwnSidebarRef.current) return;

    // Check if sidebar is showing our file
    if (!sidebarContent || !isSidebarFile(sidebarContent)) return;
    if (!input?.path) return;
    if (sidebarContent.path !== input.path) return;

    // Only update if content actually changed
    if (lastStreamedContentRef.current === writeStreamingContent) return;
    lastStreamedContentRef.current = writeStreamingContent;

    updateSidebarContent({
      content: writeStreamingContent,
    });
  }, [
    action,
    part.state,
    input?.path,
    writeStreamingContent,
    sidebarOpen,
    sidebarContent,
    updateSidebarContent,
  ]);

  // Reset tracking refs when tool completes or changes
  useEffect(() => {
    if (part.state === "output-available") {
      isOwnSidebarRef.current = false;
      lastStreamedContentRef.current = null;
    }
  }, [part.state]);

  const getFileRange = () => {
    if (!input?.range) return "";
    const [start, end] = input.range;
    if (end === -1) {
      return ` L${start}+`;
    }
    return ` L${start}-${end}`;
  };

  const handleOpenStreamingSidebar = () => {
    if (!input?.path) return;
    isOwnSidebarRef.current = true;
    lastStreamedContentRef.current = input.text || "";
    openSidebar({
      path: input.path,
      content: input.text || "",
      action: action === "append" ? "appending" : "creating",
      toolCallId: part.toolCallId,
      isExecuting: true,
    });
  };

  const handleStreamingKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleOpenStreamingSidebar();
    }
  };

  const renderReadAction = () => {
    const { toolCallId, state, output } = part;

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
            target={input ? `${input.path}${getFileRange()}` : undefined}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        if (!input) return null;

        const readOutput = output;
        const isError =
          typeof readOutput === "object" &&
          readOutput !== null &&
          "error" in readOutput;
        const errorMessage = isError
          ? (readOutput as { error: string }).error
          : null;

        const handleOpenInSidebar = () => {
          const cleanContent =
            !isError &&
            typeof readOutput === "object" &&
            readOutput !== null &&
            "originalContent" in readOutput
              ? (readOutput as { originalContent: string }).originalContent
              : "";

          const range = input.range
            ? {
                start: input.range[0],
                end: input.range[1] === -1 ? undefined : input.range[1],
              }
            : undefined;

          openSidebar({
            path: input.path,
            content: cleanContent,
            range,
            action: "reading",
            isExecuting: false,
            error: errorMessage ?? undefined,
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
            action={isError ? `Failed to read` : "Read"}
            target={`${input.path}${getFileRange()}`}
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
            action={hasContent ? "Creating" : "Creating file"}
            target={hasFilePath ? input.path : undefined}
            isShimmer={true}
            isClickable={hasContent && hasFilePath}
            onClick={
              hasContent && hasFilePath ? handleOpenStreamingSidebar : undefined
            }
            onKeyDown={
              hasContent && hasFilePath ? handleStreamingKeyDown : undefined
            }
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
            target={input?.path}
            isShimmer={true}
            isClickable={!!input?.path}
            onClick={input?.path ? handleOpenStreamingSidebar : undefined}
            onKeyDown={input?.path ? handleStreamingKeyDown : undefined}
          />
        );
      case "output-available": {
        if (!input) return null;

        const writeOutput = part.output;
        const isError =
          typeof writeOutput === "object" &&
          writeOutput !== null &&
          "error" in writeOutput;
        const errorMessage = isError
          ? (writeOutput as { error: string }).error
          : null;

        const handleOpenWriteSidebar = () => {
          isOwnSidebarRef.current = false;
          openSidebar({
            path: input.path,
            content: isError ? "" : input.text || "",
            action: "writing",
            isExecuting: false,
            error: errorMessage ?? undefined,
          });
        };

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FilePlus />}
            action={isError ? "Failed to write" : "Successfully wrote"}
            target={input.path}
            isClickable={true}
            onClick={handleOpenWriteSidebar}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleOpenWriteSidebar();
              }
            }}
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
            action={hasContent ? "Appending to" : "Appending"}
            target={hasFilePath ? input.path : undefined}
            isShimmer={true}
            isClickable={hasContent && hasFilePath}
            onClick={
              hasContent && hasFilePath ? handleOpenStreamingSidebar : undefined
            }
            onKeyDown={
              hasContent && hasFilePath ? handleStreamingKeyDown : undefined
            }
          />
        );
      }
      case "input-available":
        if (status !== "streaming") return null;
        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileOutput />}
            action="Appending to"
            target={input?.path}
            isShimmer={true}
            isClickable={!!input?.path}
            onClick={input?.path ? handleOpenStreamingSidebar : undefined}
            onKeyDown={input?.path ? handleStreamingKeyDown : undefined}
          />
        );
      case "output-available": {
        if (!input) return null;

        const appendOutput = part.output;
        const isError =
          typeof appendOutput === "object" &&
          appendOutput !== null &&
          "error" in appendOutput;
        const errorMessage = isError
          ? (appendOutput as { error: string }).error
          : null;

        const handleOpenAppendSidebar = () => {
          // Get diff data from output object (only if not error)
          const original =
            !isError &&
            typeof appendOutput === "object" &&
            appendOutput !== null &&
            "originalContent" in appendOutput
              ? (appendOutput.originalContent as string)
              : "";
          const modified =
            !isError &&
            typeof appendOutput === "object" &&
            appendOutput !== null &&
            "modifiedContent" in appendOutput
              ? (appendOutput.modifiedContent as string)
              : "";

          isOwnSidebarRef.current = false;
          openSidebar({
            path: input.path,
            content: modified,
            action: "appending",
            toolCallId: part.toolCallId,
            originalContent: original,
            modifiedContent: modified,
            isExecuting: false,
            error: errorMessage ?? undefined,
          });
        };

        return (
          <ToolBlock
            key={toolCallId}
            icon={<FileOutput />}
            action={
              isError ? "Failed to append to" : "Successfully appended to"
            }
            target={input.path}
            isClickable={true}
            onClick={handleOpenAppendSidebar}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleOpenAppendSidebar();
              }
            }}
          />
        );
      }
      default:
        return null;
    }
  };

  const renderEditAction = () => {
    const { toolCallId, state, output } = part;

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
              input?.edits
                ? `Making ${input.edits.length} edit${input.edits.length > 1 ? "s" : ""} to`
                : "Editing"
            }
            target={input?.path}
            isShimmer={true}
          />
        ) : null;
      case "output-available": {
        if (!input) return null;

        const editOutput = output;
        const isError =
          typeof editOutput === "object" &&
          editOutput !== null &&
          "error" in editOutput;
        const errorMessage = isError
          ? (editOutput as { error: string }).error
          : null;

        const handleOpenInSidebar = () => {
          // Get diff data from output (only if not error)
          const original =
            !isError &&
            typeof editOutput === "object" &&
            editOutput !== null &&
            "originalContent" in editOutput
              ? (editOutput.originalContent as string)
              : undefined;
          const modified =
            !isError &&
            typeof editOutput === "object" &&
            editOutput !== null &&
            "modifiedContent" in editOutput
              ? (editOutput.modifiedContent as string)
              : "";

          openSidebar({
            path: input.path,
            content: modified,
            action: "editing",
            toolCallId,
            originalContent: original,
            modifiedContent: modified,
            isExecuting: false,
            error: errorMessage ?? undefined,
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
            icon={<FilePen />}
            action={isError ? "Failed to edit" : "Edited"}
            target={input.path}
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
