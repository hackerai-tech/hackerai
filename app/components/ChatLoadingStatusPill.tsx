import { LoaderCircle } from "lucide-react";

const LOADING_MESSAGES_LABEL = "Loading messages...";

export function ChatLoadingStatusPill() {
  return (
    <div
      aria-label={LOADING_MESSAGES_LABEL}
      className="pointer-events-none mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-border/60 bg-card/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-sm"
      role="status"
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="truncate">{LOADING_MESSAGES_LABEL}</span>
    </div>
  );
}
