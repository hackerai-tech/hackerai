"use client";

import { memo, useMemo } from "react";
import { CircleAlert, ShieldAlert } from "lucide-react";
import ToolBlock from "@/components/ui/tool-block";
import { isSidebarToolError, type SidebarToolError } from "@/types/chat";
import { useToolSidebar } from "@/app/hooks/useToolSidebar";
import { createToolInputErrorContent } from "@/lib/chat/tool-error-display";

export function ToolErrorBlock({
  content,
  onOpen,
}: {
  content: SidebarToolError;
  onOpen: () => void;
}) {
  const isFinding = content.toolName === "Vulnerability report";

  return (
    <ToolBlock
      icon={
        isFinding ? (
          <ShieldAlert aria-hidden="true" />
        ) : (
          <CircleAlert aria-hidden="true" />
        )
      }
      action={content.action}
      target="View details"
      isClickable
      onClick={onOpen}
      ariaLabel={`Open ${content.toolName.toLowerCase()} error details`}
    />
  );
}

export const ToolErrorHandler = memo(function ToolErrorHandler({
  content,
}: {
  content: SidebarToolError;
}) {
  const { handleOpenInSidebar } = useToolSidebar({
    toolCallId: content.toolCallId,
    content,
    typeGuard: isSidebarToolError,
  });

  return <ToolErrorBlock content={content} onOpen={handleOpenInSidebar} />;
});

export const ToolValidationErrorHandler = memo(
  function ToolValidationErrorHandler({
    toolType,
    toolCallId,
    errorText,
  }: {
    toolType: string;
    toolCallId: string;
    errorText?: unknown;
  }) {
    const content = useMemo(
      () => createToolInputErrorContent({ toolType, toolCallId, errorText }),
      [errorText, toolCallId, toolType],
    );
    return <ToolErrorHandler content={content} />;
  },
);
