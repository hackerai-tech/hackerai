"use client";

import { NotebookText } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type ContextDetailsChat = {
  active_trigger_run_id?: string;
  default_model_slug?: "ask" | "agent" | "agent-long";
  agent_compaction_count?: number;
};

/** Agent chats only: an active run, a saved Agent mode, or a tracked count. */
export function hasAgentContext(chat: ContextDetailsChat | null | undefined) {
  if (!chat) return false;
  return (
    Boolean(chat.active_trigger_run_id) ||
    chat.default_model_slug === "agent" ||
    chat.default_model_slug === "agent-long" ||
    chat.agent_compaction_count !== undefined
  );
}

const isKnownCount = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;

export function ChatContextDetails({
  completedCompactions,
}: {
  /** Undefined when this chat's compactions were never recorded. */
  completedCompactions?: number;
}) {
  const known = isKnownCount(completedCompactions);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Context details"
          data-testid="context-details-trigger"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium transition-colors outline-none hover:bg-[#ffffff1a] focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-[#ffffff1a] md:h-[34px] md:w-auto md:gap-1.5 md:ps-2.5 md:pe-3"
        >
          <NotebookText aria-hidden="true" className="size-5 md:size-4" />
          <span aria-hidden="true" className="max-md:hidden">
            Context
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={12}
        aria-label="Agent context"
        className="w-[280px] max-w-[calc(100vw-24px)] p-4"
      >
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-sm font-medium">Agent context</p>
          <p className="text-xs text-muted-foreground">This chat</p>
        </div>
        <dl
          aria-live="polite"
          aria-atomic="true"
          className="mt-3 border-t pt-3"
        >
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[13px] text-muted-foreground">
              Completed compactions
            </dt>
            <dd
              className={
                known ? "text-sm font-medium tabular-nums" : "text-[13px]"
              }
            >
              {known ? completedCompactions : "Unavailable"}
            </dd>
          </div>
        </dl>
        <p className="mt-1 text-xs text-muted-foreground">
          {known
            ? "Includes compactions recorded since tracking began."
            : "No compaction count has been recorded for this chat."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
