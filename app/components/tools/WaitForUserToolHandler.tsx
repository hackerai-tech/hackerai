import { memo } from "react";
import { MessageCircleQuestionMark } from "lucide-react";

import ToolBlock from "@/components/ui/tool-block";
import { isUserStoppedToolError } from "@/lib/chat/tool-abort-utils";
import type { ChatStatus } from "@/types/chat";

export const WaitForUserToolHandler = memo(function WaitForUserToolHandler({
  part,
  status,
}: {
  part: any;
  status: ChatStatus;
}) {
  const { state, output, errorText, toolCallId } = part;
  const icon = <MessageCircleQuestionMark aria-hidden="true" />;

  if (state === "input-streaming") {
    return status === "streaming" ? (
      <ToolBlock icon={icon} action="Preparing a question" isShimmer />
    ) : null;
  }
  if (state === "input-available") {
    return (
      <ToolBlock
        icon={icon}
        action={
          status === "ready" || status === "error"
            ? "Wait ended without a reply"
            : "Waiting for your reply"
        }
      />
    );
  }
  if (state === "output-error") {
    return (
      <ToolBlock
        icon={icon}
        action={
          isUserStoppedToolError(errorText)
            ? "Stopped while waiting for your reply"
            : "Could not wait for your reply"
        }
      />
    );
  }
  if (state !== "output-available") return null;
  if (output?.wait_outcome === "timed_out") {
    return <ToolBlock icon={icon} action="No reply before the wait ended" />;
  }
  if (output?.success === false) {
    return <ToolBlock icon={icon} action="Could not wait for your reply" />;
  }

  const reply = typeof output?.reply === "string" ? output.reply : "";
  return (
    <div
      className="min-w-0 space-y-2"
      data-testid={`wait-for-user-${toolCallId}`}
    >
      <ToolBlock icon={icon} action="Reply received" />
      {reply && (
        <div className="max-w-prose rounded-xl border border-border bg-muted/20 px-3 py-2 text-sm text-foreground">
          <span className="block text-xs font-medium text-muted-foreground">
            Your reply
          </span>
          <p className="mt-1 whitespace-pre-wrap break-words">{reply}</p>
        </div>
      )}
    </div>
  );
});
