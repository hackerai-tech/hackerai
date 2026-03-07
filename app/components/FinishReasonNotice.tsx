import { ChatMode } from "@/types/chat";
import { useDataStream } from "@/app/components/DataStreamProvider";
import { MAX_AUTO_CONTINUES } from "@/app/hooks/useAutoContinue";

interface FinishReasonNoticeProps {
  finishReason?: string;
  mode?: ChatMode;
}

export const FinishReasonNotice = ({
  finishReason,
  mode,
}: FinishReasonNoticeProps) => {
  const { isAutoResuming, autoContinueCount } = useDataStream();

  if (isAutoResuming) return null;

  // Suppress for auto-continuable reasons in agent mode when more auto-continues will fire
  if (
    mode === "agent" &&
    autoContinueCount < MAX_AUTO_CONTINUES &&
    (finishReason === "context-limit" || finishReason === "length")
  ) {
    return null;
  }

  if (!finishReason) return null;

  const getNoticeContent = () => {
    if (finishReason === "tool-calls") {
      return (
        <>
          I automatically stopped to prevent going off course. Say
          &quot;continue&quot; if you&apos;d like me to keep working on this
          task.
        </>
      );
    }

    if (finishReason === "timeout") {
      return (
        <>
          I had to stop due to the time limit. Say &quot;continue&quot; if
          you&apos;d like me to keep working on this task.
        </>
      );
    }

    if (finishReason === "length") {
      return (
        <>
          I hit the output token limit and had to stop. Say &quot;continue&quot;
          to pick up where I left off.
        </>
      );
    }

    if (finishReason === "context-limit") {
      return (
        <>
          I reached the context limit for this conversation after summarizing
          earlier messages. Say &quot;continue&quot; to pick up where I left
          off.
        </>
      );
    }

    return null;
  };

  const content = getNoticeContent();

  if (!content) return null;

  return (
    <div className="mt-2 w-full">
      <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border">
        {content}
      </div>
    </div>
  );
};
