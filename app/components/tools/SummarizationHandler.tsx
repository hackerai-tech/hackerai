import { UIMessage } from "@ai-sdk/react";
import { WandSparkles } from "lucide-react";
import { ShimmerText } from "../ShimmerText";

interface SummarizationHandlerProps {
  message: UIMessage;
  part: any;
  partIndex: number;
}

export const SummarizationHandler = ({
  message,
  part,
  partIndex,
}: SummarizationHandlerProps) => {
  return (
    <div
      key={`${message.id}-summarization-${partIndex}`}
      className="mb-3 flex items-center gap-2"
    >
      <WandSparkles className="w-4 h-4 text-muted-foreground" />
      {part.data.status === "started" ? (
        <ShimmerText className="text-sm">{part.data.message}...</ShimmerText>
      ) : (
        <span className="text-sm text-muted-foreground">
          {part.data.message}
        </span>
      )}
    </div>
  );
};
