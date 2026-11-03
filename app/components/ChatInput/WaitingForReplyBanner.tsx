"use client";

import { MessageCircleQuestionMark } from "lucide-react";
import { Button } from "@/components/ui/button";

export const WAITING_FOR_REPLY_DESCRIPTION_ID = "waiting-for-reply-description";

export function WaitingForReplyBanner({
  submitting,
  stopping,
  hasAttachments,
  hideStop,
  onStop,
}: {
  submitting: boolean;
  stopping: boolean;
  hasAttachments: boolean;
  hideStop: boolean;
  onStop: () => void;
}) {
  return (
    <div
      className="mx-4 flex min-w-0 items-start gap-2 rounded-[22px_22px_0px_0px] border border-b-0 border-black/8 bg-input-chat px-3 py-2.5 sm:items-center dark:border-border"
      data-testid="waiting-for-reply-banner"
    >
      <MessageCircleQuestionMark
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-foreground sm:mt-0"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          Agent is waiting for your reply
        </p>
        <p
          id={WAITING_FOR_REPLY_DESCRIPTION_ID}
          className="text-xs leading-5 text-muted-foreground"
        >
          {hasAttachments
            ? "Remove attachments to reply. This reply accepts text only."
            : submitting
              ? "Sending your reply. You can retry the same text if it stalls."
              : "Send a message below to continue this run."}
        </p>
      </div>
      {!hideStop && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onStop}
          disabled={stopping}
          aria-label="Stop agent instead of replying"
          className="min-h-9 shrink-0 rounded-full px-3 text-xs sm:min-h-7"
        >
          {stopping ? "Stopping…" : "Stop agent"}
        </Button>
      )}
    </div>
  );
}
