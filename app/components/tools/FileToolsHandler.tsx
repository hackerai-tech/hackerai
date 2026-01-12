import { useMemo, useEffect, useRef } from "react";
import { UIMessage } from "@ai-sdk/react";
import ToolBlock from "@/components/ui/tool-block";
import { FilePlus, FileText, FilePen, FileMinus } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus } from "@/types";
import { isSidebarFile } from "@/types/chat";

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
  const { openSidebar, updateSidebarContent, sidebarContent, sidebarOpen } =
    useGlobalState();

  // Track the last streamed content to avoid unnecessary updates
  const lastStreamedContentRef = useRef<string | null>(null);
  // Track if this tool opened the sidebar (to know when to update it)
  const isOwnSidebarRef = useRef(false);

  // Extract streaming write content for write_file tool
  const writeStreamingContent = useMemo(() => {
    if (part.type !== "tool-write_file") return null;
    const writeInput = part.input as
      | { file_path: string; contents: string }
      | undefined;
    return writeInput?.contents || null;
  }, [part.type, part.input]);

  // Update sidebar content as write_file content streams in
  useEffect(() => {
    // Only update for write_file tool during streaming
    if (part.type !== "tool-write_file") return;
    if (part.state !== "input-streaming" && part.state !== "input-available")
      return;
    if (!writeStreamingContent) return;
    if (!sidebarOpen || !isOwnSidebarRef.current) return;

    // Check if sidebar is showing our file
    if (!sidebarContent || !isSidebarFile(sidebarContent)) return;

    const writeInput = part.input as
      | { file_path: string; contents: string }
      | undefined;
    if (!writeInput?.file_path) return;
    if (sidebarContent.path !== writeInput.file_path) return;

    // Only update if content actually changed
    if (lastStreamedContentRef.current === writeStreamingContent) return;
    lastStreamedContentRef.current = writeStreamingContent;

    updateSidebarContent({
      content: writeStreamingContent,
    });
  }, [
    part.type,
    part.state,
    part.input,
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

  // Extract diff data from data-diff parts in the message (streamed separately from tool result)
  // This data only exists in memory/stream - not persisted, so on reload we just show the result message
  const diffDataFromStream = useMemo(() => {
    if (part.type !== "tool-search_replace") return null;

    const diffPart = message.parts.find(
      (p): p is DiffDataPart =>
        p.type === "data-diff" &&
        (p as DiffDataPart).data?.toolCallId === part.toolCallId,
    );

    return diffPart?.data || null;
  }, [message.parts, part.type, part.toolCallId]);

  const renderReadFileTool = () => {
    const { toolCallId, state, input, output } = part;
    const readInput = input as
      | {
          target_file: string;
          offset?: number;
          limit?: number;
        }
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
    const writeInput = input as
      | {
          file_path: string;
          contents: string;
        }
      | undefined;

    const handleOpenStreamingSidebar = () => {
      if (!writeInput?.file_path) return;
      isOwnSidebarRef.current = true;
      lastStreamedContentRef.current = writeInput.contents || "";
      openSidebar({
        path: writeInput.file_path,
        content: writeInput.contents || "",
        action: "creating",
        toolCallId,
      });
    };

    const handleStreamingKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleOpenStreamingSidebar();
      }
    };

    switch (state) {
      case "input-streaming": {
        // Show shimmer when just starting, clickable when content starts arriving
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
            target={writeInput?.file_path}
            isShimmer={true}
            isClickable={!!writeInput?.file_path}
            onClick={
              writeInput?.file_path ? handleOpenStreamingSidebar : undefined
            }
            onKeyDown={
              writeInput?.file_path ? handleStreamingKeyDown : undefined
            }
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
            isClickable={true}
            onClick={() => {
              isOwnSidebarRef.current = false;
              openSidebar({
                path: writeInput.file_path,
                content: writeInput.contents,
                action: "writing",
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                isOwnSidebarRef.current = false;
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
    const deleteInput = input as
      | {
          target_file: string;
          explanation: string;
        }
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

        const handleOpenInSidebar = () => {
          // Use diff data from stream if available (not persisted across reloads)
          openSidebar({
            path: searchReplaceInput.file_path,
            content:
              diffDataFromStream?.modifiedContent || searchReplaceOutput.result,
            action: "editing",
            toolCallId,
            originalContent: diffDataFromStream?.originalContent,
            modifiedContent: diffDataFromStream?.modifiedContent,
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
            action={isSuccess ? "Successfully edited" : "Failed to edit"}
            target={searchReplaceInput.file_path}
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

  const renderMultiEditTool = () => {
    const { toolCallId, state, input, output } = part;
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
