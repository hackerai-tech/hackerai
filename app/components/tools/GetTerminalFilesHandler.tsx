import React from "react";
import ToolBlock from "@/components/ui/tool-block";
import { FileDown } from "lucide-react";
import type { ChatStatus } from "@/types/chat";

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

interface GetTerminalFilesHandlerProps {
  part: TerminalFilesPart;
  status: ChatStatus;
}

export const GetTerminalFilesHandler = ({
  part,
  status,
}: GetTerminalFilesHandlerProps) => {
  const { toolCallId, state, input, output } = part;
  const filesInput = input;
  const filesOutput = output;

  const getFileNames = (paths: string[]) => {
    return paths.map((path) => path.split("/").pop() || path).join(", ");
  };

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
          target={getFileNames(filesInput?.files || [])}
          isShimmer={status === "streaming"}
        />
      );

    case "output-available": {
      // Support both new (files) and legacy (fileUrls) formats
      const fileCount =
        filesOutput?.files?.length || filesOutput?.fileUrls?.length || 0;
      const fileNames = getFileNames(filesInput?.files || []);

      return (
        <ToolBlock
          key={toolCallId}
          icon={<FileDown />}
          action={`Shared ${fileCount} file${fileCount !== 1 ? "s" : ""}`}
          target={fileNames}
        />
      );
    }

    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<FileDown />}
          action="Failed to share"
          target={getFileNames(filesInput?.files || [])}
        />
      );

    default:
      return null;
  }
};
