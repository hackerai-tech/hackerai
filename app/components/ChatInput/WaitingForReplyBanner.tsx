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
      className="relative mx-3 -mb-3 flex min-w-0 items-center gap-2 rounded-t-xl border border-b-0 border-black/8 bg-input-chat px-3 pb-4 pt-1.5 dark:border-border"
      data-testid="waiting-for-reply-banner"
    >
      <MessageCircleQuestionMark
        aria-hidden="true"
        className="size-3.5 shrink-0 text-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium leading-5 text-foreground">
          {submitting ? "Sending reply…" : "Input"}
        </p>
        <p
          id={WAITING_FOR_REPLY_DESCRIPTION_ID}
          className={
            hasAttachments
              ? "text-xs leading-5 text-muted-foreground"
              : "sr-only"
          }
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
          className="-mr-1 min-h-8 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground sm:h-6 sm:min-h-6"
        >
          {stopping ? "Stopping…" : "Parar"}
        </Button>
      )}
    </div>
  );
}
