import { memo } from "react";
import { UIMessage } from "@ai-sdk/react";
import { WandSparkles, ChevronDownIcon } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { MemoizedMarkdown } from "../MemoizedMarkdown";
import { cn } from "@/lib/utils";

interface SummarizationHandlerProps {
  message: UIMessage;
  part: any;
  partIndex: number;
}

function areSummarizationPropsEqual(
  prev: SummarizationHandlerProps,
  next: SummarizationHandlerProps,
): boolean {
  if (prev.message.id !== next.message.id) return false;
  if (prev.partIndex !== next.partIndex) return false;
  if (prev.part.data?.status !== next.part.data?.status) return false;
  if (prev.part.data?.message !== next.part.data?.message) return false;
  if (prev.part.data?.messageSummary !== next.part.data?.messageSummary)
    return false;
  if (prev.part.data?.stepSummary !== next.part.data?.stepSummary) return false;
  return true;
}

export const SummarizationHandler = memo(function SummarizationHandler({
  message,
  part,
  partIndex,
}: SummarizationHandlerProps) {
  const messageSummary: string | undefined = part.data?.messageSummary;
  const stepSummary: string | undefined = part.data?.stepSummary;
  const hasSummary = Boolean(messageSummary || stepSummary);

  if (part.data.status === "started") {
    return (
      <div
        key={`${message.id}-summarization-${partIndex}`}
        className="mb-3 flex items-center gap-2"
      >
        <WandSparkles className="w-4 h-4 text-muted-foreground" />
        <Shimmer className="text-sm">{`${part.data.message}...`}</Shimmer>
      </div>
    );
  }

  if (!hasSummary) {
    return (
      <div
        key={`${message.id}-summarization-${partIndex}`}
        className="mb-3 flex items-center gap-2"
      >
        <WandSparkles className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          {part.data.message}
        </span>
      </div>
    );
  }

  return (
    <Collapsible
      key={`${message.id}-summarization-${partIndex}`}
      className="not-prose mb-3 w-full space-y-2"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <WandSparkles className="size-4" />
        <span className="flex-1 text-left">{part.data.message}</span>
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "text-muted-foreground max-h-60 overflow-y-auto",
          "data-[state=closed]:animate-out data-[state=open]:animate-in",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2",
        )}
      >
        <div className="ml-6 space-y-3 text-sm">
          {messageSummary && (
            <div>
              <p className="font-medium text-muted-foreground/80 mb-1">
                Message Summary
              </p>
              <MemoizedMarkdown content={messageSummary} />
            </div>
          )}
          {stepSummary && (
            <div>
              <p className="font-medium text-muted-foreground/80 mb-1">
                Step Summary
              </p>
              <MemoizedMarkdown content={stepSummary} />
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}, areSummarizationPropsEqual);
