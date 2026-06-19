import { useState } from "react";
import { ChatMode } from "@/types/chat";
import { useDataStreamState } from "@/app/components/DataStreamProvider";
import { MAX_AUTO_CONTINUES } from "@/app/hooks/useAutoContinue";
import { Button } from "@/components/ui/button";
import { captureAgentRunSpendCapContinueClick } from "@/lib/analytics/client";
import { AGENT_RUN_SPEND_CAP_REASON } from "@/lib/chat/agent-run-spend-cap";

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
  const [hasContinued, setHasContinued] = useState(false);

  if (isAutoResuming) return null;
  if (hasContinued) return null;

  // Suppress for auto-continuable reasons in agent mode when more auto-continues will fire
  if (
    mode === "agent" &&
    autoContinueCount < MAX_AUTO_CONTINUES &&
    (finishReason === "context-limit" ||
      finishReason === "length" ||
      finishReason === "preemptive-timeout" ||
      finishReason === "tool-calls")
  ) {
    return null;
  }

  if (!finishReason) return null;

  const getNoticeContent = () => {
    if (finishReason === "tool-calls") {
      return <>Reached the step limit for this turn.</>;
    }

    if (finishReason === "timeout" || finishReason === "preemptive-timeout") {
      return <>Reached the time limit for this turn.</>;
    }

    if (finishReason === "length") {
      return <>Reached the output limit for this turn.</>;
    }

    if (finishReason === "context-limit") {
      return <>Reached the context limit for this conversation.</>;
    }

    if (finishReason === "agent-run-spend-cap") {
      return <>Paused at the Pro Agent per-run safety cap.</>;
    }

    return null;
  };

  const content = getNoticeContent();

  if (!content) return null;

  return (
    <div className="mt-2 w-full">
      <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border flex items-center justify-between gap-3 flex-wrap">
        <span>{content}</span>
        {onContinue && !hasContinued && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setHasContinued(true);
              if (finishReason === "agent-run-spend-cap") {
                captureAgentRunSpendCapContinueClick({
                  surface: "finish_reason_notice",
                  source: AGENT_RUN_SPEND_CAP_REASON,
                  finish_reason: finishReason,
                  mode: mode ?? "agent",
                  cap_reason: AGENT_RUN_SPEND_CAP_REASON,
                });
              }
              onContinue();
            }}
          >
            Continue
          </Button>
        )}
      </div>
    </div>
  );
};
