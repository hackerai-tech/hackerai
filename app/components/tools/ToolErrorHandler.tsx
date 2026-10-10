"use client";

import { memo, useMemo, type KeyboardEventHandler } from "react";
import { CircleAlert, ShieldAlert } from "lucide-react";
import ToolBlock from "@/components/ui/tool-block";
import { isSidebarToolError, type SidebarToolError } from "@/types/chat";
import { useToolSidebar } from "@/app/hooks/useToolSidebar";
import { createToolInputErrorContent } from "@/lib/chat/tool-error-display";

export function ToolErrorBlock({
  content,
  onOpen,
  onKeyDown,
}: {
  content: SidebarToolError;
  onOpen: () => void;
  onKeyDown?: KeyboardEventHandler;
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
      onKeyDown={onKeyDown}
      ariaLabel={`Open ${content.toolName.toLowerCase()} error details`}
    />
  );
}

export const ToolErrorHandler = memo(function ToolErrorHandler({
  content,
}: {
  content: SidebarToolError;
}) {
  const { handleOpenInSidebar, handleKeyDown } = useToolSidebar({
    toolCallId: content.toolCallId,
    content,
    typeGuard: isSidebarToolError,
  });

  return (
    <ToolErrorBlock
      content={content}
      onOpen={handleOpenInSidebar}
      onKeyDown={handleKeyDown}
    />
  );
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
