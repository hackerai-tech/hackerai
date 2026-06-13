import { memo } from "react";
import { UIMessage } from "@ai-sdk/react";
import { SummarizationStatusDivider } from "../SummarizationStatusDivider";

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
    <SummarizationStatusDivider
      key={`${message.id}-summarization-${partIndex}`}
      status={part.data?.status}
      message={part.data?.message}
    />
  );
}, areSummarizationPropsEqual);
