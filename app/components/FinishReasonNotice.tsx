import { ChatMode } from "@/types/chat";
import { useDataStreamState } from "@/app/components/DataStreamProvider";
import { MAX_AUTO_CONTINUES } from "@/app/hooks/useAutoContinue";
import { Button } from "@/components/ui/button";

interface FinishReasonNoticeProps {
  finishReason?: string;
  mode?: ChatMode;
  onContinue?: () => void;
}

export const FinishReasonNotice = ({
  finishReason,
  mode,
  onContinue,
}: FinishReasonNoticeProps) => {
  const { isAutoResuming, autoContinueCount } = useDataStreamState();

  if (isAutoResuming) return null;

  // Suppress for auto-continuable reasons in agent mode when more auto-continues will fire
  if (
    mode === "agent" &&
    autoContinueCount < MAX_AUTO_CONTINUES &&
    (finishReason === "context-limit" ||
      finishReason === "length" ||
      finishReason === "preemptive-timeout")
  ) {
    return null;
  }

  if (!finishReason) return null;

  const getNoticeContent = () => {
    if (finishReason === "tool-calls") {
      return <>I automatically stopped to prevent going off course.</>;
    }

    if (finishReason === "timeout") {
      return <>I had to stop due to the time limit.</>;
    }

    if (finishReason === "length") {
      return <>I hit the output token limit and had to stop.</>;
    }

    if (finishReason === "context-limit") {
      return (
        <>
          I reached the context limit for this conversation after summarizing
          earlier messages.
        </>
      );
    }

    if (finishReason === "preemptive-timeout") {
      return <>I had to stop because the session exceeded the time limit.</>;
    }

    return null;
  };

  const content = getNoticeContent();

  if (!content) return null;

  return (
    <div className="mt-2 w-full">
      <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border flex items-center justify-between gap-3 flex-wrap">
        <span>{content}</span>
        {onContinue && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onContinue}
          >
            Continue
          </Button>
        )}
      </div>
    </div>
  );
};
