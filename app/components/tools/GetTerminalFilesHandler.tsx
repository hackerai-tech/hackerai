import React from "react";
import ToolBlock from "@/components/ui/tool-block";
import { FileDown } from "lucide-react";
import type { ChatStatus } from "@/types/chat";

interface GetTerminalFilesHandlerProps {
  part: any;
  status: ChatStatus;
}

export const GetTerminalFilesHandler = ({
  part,
  status,
}: GetTerminalFilesHandlerProps) => {
  const { toolCallId, state, input, output } = part;
  const filesInput = input as { files: string[] };
  const filesOutput = output as {
    result: string;
    fileUrls: Array<{ path: string; downloadUrl: string }>;
  };

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

    case "output-available":
      const fileCount = filesOutput?.fileUrls?.length || 0;
      const fileNames = getFileNames(filesInput?.files || []);

      return (
        <ToolBlock
          key={toolCallId}
          icon={<FileDown />}
          action={`Shared ${fileCount} file${fileCount !== 1 ? "s" : ""}`}
          target={fileNames}
        />
      );

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
