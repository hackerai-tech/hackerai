import React, { memo, useMemo } from "react";
import ToolBlock from "@/components/ui/tool-block";
import { FileDown } from "lucide-react";
import { useToolSidebar } from "@/app/hooks/useToolSidebar";
import {
  isSidebarSharedFiles,
  type ChatStatus,
  type SidebarSharedFiles,
} from "@/types/chat";
import type { FileDetails } from "@/types/file";

interface TerminalFilesPart {
  toolCallId: string;
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  input?: { files: string[] };
  output?: {
    result: string;
    files?: Array<{ path: string }>;
    // Legacy support for old messages
    fileUrls?: Array<{ path: string; downloadUrl?: string }>;
  };
}

export interface GetTerminalFilesHandlerProps {
  part: TerminalFilesPart;
  status: ChatStatus;
  sharedFileDetails?: FileDetails[];
}

export const GetTerminalFilesHandler = memo(function GetTerminalFilesHandler({
  part,
  status,
  sharedFileDetails,
}: GetTerminalFilesHandlerProps) {
  const { toolCallId, state, input, output } = part;

  // Memoize requestedPaths to prevent unstable references from triggering
  // infinite re-render loops via useToolSidebar's updateSidebarContent effect.
  const requestedPaths = useMemo(() => input?.files || [], [input?.files]);

  const getFileNames = (paths: string[]) => {
    return paths.map((path) => path.split("/").pop() || path).join(", ");
  };

  const isExecuting =
    state === "input-streaming" ||
    (state === "input-available" && status === "streaming");

  // Build sidebar content from streamed file details
  const sidebarContent = useMemo((): SidebarSharedFiles | null => {
    if (state === "input-streaming" && status !== "streaming") return null;

    const files: SidebarSharedFiles["files"] = (sharedFileDetails || []).map(
      (f) => ({
        name: f.name,
        mediaType: f.mediaType,
        fileId: f.fileId as string,
        s3Key: f.s3Key,
        storageId: f.storageId,
      }),
    );

    return {
      files,
      requestedPaths,
      isExecuting,
      toolCallId,
    };
  }, [
    sharedFileDetails,
    requestedPaths,
    isExecuting,
    toolCallId,
    state,
    status,
  ]);

  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId,
    content: sidebarContent,
    typeGuard: isSidebarSharedFiles,
  });

  const isClickable = !!sidebarContent && sidebarContent.files.length > 0;

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<FileDown />}
          action="Preparing"
          isShimmer={true}
        />
      ) : null;

    case "input-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<FileDown />}
          action={status === "streaming" ? "Sharing" : "Shared"}
          target={getFileNames(requestedPaths)}
          isShimmer={status === "streaming"}
          isClickable={isClickable}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );

    case "output-available": {
      const fileCount = output?.files?.length || output?.fileUrls?.length || 0;
      const fileNames = getFileNames(requestedPaths);

      return (
        <ToolBlock
          key={toolCallId}
          icon={<FileDown />}
          action={`Shared ${fileCount} file${fileCount !== 1 ? "s" : ""}`}
          target={fileNames}
          isClickable={isClickable}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    }

    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<FileDown />}
          action="Failed to share"
          target={getFileNames(requestedPaths)}
        />
      );

    default:
      return null;
  }
});
