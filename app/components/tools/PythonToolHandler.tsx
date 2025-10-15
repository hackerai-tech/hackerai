import React, { useEffect, useMemo, useCallback } from "react";
import { UIMessage } from "@ai-sdk/react";
import ToolBlock from "@/components/ui/tool-block";
import { Code2 } from "lucide-react";
import { useGlobalState } from "../../contexts/GlobalState";
import type { ChatStatus, SidebarPython } from "@/types/chat";
import { isSidebarPython } from "@/types/chat";

interface PythonToolHandlerProps {
  message: UIMessage;
  part: any;
  status: ChatStatus;
}

export const PythonToolHandler = ({
  message,
  part,
  status,
}: PythonToolHandlerProps) => {
  const { openSidebar, sidebarOpen, sidebarContent, updateSidebarContent } =
    useGlobalState();
  const { toolCallId, state, input, output, errorText } = part;
  const pythonInput = input as { code: string };
  const pythonOutput = output as {
    result: {
      stdout?: string;
      stderr?: string;
      results?: any[];
      exitCode?: number | null;
      error?: string;
    };
    fileUrls?: Array<{ path: string; downloadUrl: string }>;
  };

  const codePreview = pythonInput?.code || "";

  // Memoize streaming output computation
  const streamingOutput = useMemo(() => {
    const pythonDataParts = message.parts.filter(
      (p) =>
        p.type === "data-python" && (p as any).data?.toolCallId === toolCallId,
    );
    return pythonDataParts.map((p) => (p as any).data?.terminal || "").join("");
  }, [message.parts, toolCallId]);

  // Memoize final output computation
  const finalOutput = useMemo(() => {
    const stdout = pythonOutput?.result?.stdout ?? "";
    const stderr = pythonOutput?.result?.stderr ?? "";
    const combinedOutput = stdout + stderr;
    return (
      combinedOutput ||
      streamingOutput ||
      (pythonOutput?.result?.error ?? "") ||
      errorText ||
      ""
    );
  }, [pythonOutput, streamingOutput, errorText]);

  const isExecuting = state === "input-available" && status === "streaming";

  const handleOpenInSidebar = useCallback(() => {
    if (!pythonInput?.code) return;

    const sidebarPython: SidebarPython = {
      code: pythonInput.code,
      output: finalOutput,
      isExecuting,
      toolCallId,
    };

    openSidebar(sidebarPython);
  }, [pythonInput?.code, finalOutput, isExecuting, toolCallId, openSidebar]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleOpenInSidebar();
      }
    },
    [handleOpenInSidebar],
  );

  // Track if this sidebar is currently active
  const isSidebarActive =
    sidebarOpen &&
    sidebarContent &&
    isSidebarPython(sidebarContent) &&
    sidebarContent.toolCallId === toolCallId;

  // Update sidebar content in real-time if it's currently open for this tool call
  useEffect(() => {
    if (!isSidebarActive) return;

    updateSidebarContent({
      code: codePreview,
      output: finalOutput,
      isExecuting,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSidebarActive, codePreview, finalOutput, isExecuting]);

  // Get file information for display
  const fileCount = pythonOutput?.fileUrls?.length || 0;
  const hasFiles = fileCount > 0;
  const fileInfo = hasFiles
    ? ` (${fileCount} file${fileCount !== 1 ? "s" : ""} saved)`
    : "";

  switch (state) {
    case "input-streaming":
      return status === "streaming" ? (
        <ToolBlock
          key={toolCallId}
          icon={<Code2 />}
          action="Generating Python code"
          target={codePreview}
          isShimmer={true}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      ) : null;
    case "input-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Code2 />}
          action={
            status === "streaming" ? "Executing Python" : "Executed Python"
          }
          target={codePreview}
          isShimmer={status === "streaming"}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    case "output-available":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Code2 />}
          action={`Executed Python${fileInfo}`}
          target={codePreview}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    case "output-error":
      return (
        <ToolBlock
          key={toolCallId}
          icon={<Code2 />}
          action={`Executed Python${fileInfo}`}
          target={codePreview}
          isClickable={true}
          onClick={handleOpenInSidebar}
          onKeyDown={handleKeyDown}
        />
      );
    default:
      return null;
  }
};
