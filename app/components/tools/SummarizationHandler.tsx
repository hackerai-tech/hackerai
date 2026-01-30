import { memo } from "react";
import { UIMessage } from "@ai-sdk/react";
import { WandSparkles } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";

interface SummarizationHandlerProps {
  message: UIMessage;
  part: any;
  partIndex: number;
}

// Custom comparison for summarization handler
function areSummarizationPropsEqual(
  prev: SummarizationHandlerProps,
  next: SummarizationHandlerProps,
): boolean {
  if (prev.message.id !== next.message.id) return false;
  if (prev.partIndex !== next.partIndex) return false;
  if (prev.part.data?.status !== next.part.data?.status) return false;
  if (prev.part.data?.message !== next.part.data?.message) return false;
  return true;
}

export const SummarizationHandler = memo(function SummarizationHandler({
  message,
  part,
  partIndex,
}: SummarizationHandlerProps) {
  return (
    <div
      key={`${message.id}-summarization-${partIndex}`}
      className="mb-3 flex items-center gap-2"
    >
      <WandSparkles className="w-4 h-4 text-muted-foreground" />
      {part.data.status === "started" ? (
        <Shimmer className="text-sm">{`${part.data.message}...`}</Shimmer>
      ) : (
        <span className="text-sm text-muted-foreground">
          {part.data.message}
        </span>
      )}
    </div>
  );
}, areSummarizationPropsEqual);
