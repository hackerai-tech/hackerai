import { useState } from "react";
import { ChatMode } from "@/types/chat";
import { useDataStreamState } from "@/app/components/DataStreamProvider";
import { MAX_AUTO_CONTINUES } from "@/app/hooks/useAutoContinue";
import { Button } from "@/components/ui/button";
import { captureAgentRunSpendCapContinueClick } from "@/lib/analytics/client";
import {
  AGENT_RUN_SPEND_CAP_FINISH_REASON,
  AGENT_RUN_SPEND_CAP_REASON,
  AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL,
} from "@/lib/chat/agent-run-spend-cap";
import { BUDGET_EXHAUSTION_FINISH_REASON } from "@/lib/chat/stop-conditions";
import type { SelectedModel } from "@/types/chat";

interface FinishReasonNoticeProps {
  finishReason?: string;
  mode?: ChatMode;
  agentRunSpendCapPremiumContinuationAllowed?: boolean;
  onContinue?: (selectedModelOverride?: SelectedModel) => void;
}

export const FinishReasonNotice = ({
  finishReason,
  mode,
  agentRunSpendCapPremiumContinuationAllowed,
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

    if (finishReason === AGENT_RUN_SPEND_CAP_FINISH_REASON) {
      return <>Paused at the Pro Agent per-run safety cap.</>;
    }

    if (finishReason === BUDGET_EXHAUSTION_FINISH_REASON) {
      return <>Stopped at a usage guardrail for this run.</>;
    }

    return null;
  };

  const content = getNoticeContent();

  if (!content) return null;

  const shouldContinueWithStandard =
    finishReason === AGENT_RUN_SPEND_CAP_FINISH_REASON &&
    agentRunSpendCapPremiumContinuationAllowed === false;
  const showContinue =
    onContinue &&
    !hasContinued &&
    finishReason !== BUDGET_EXHAUSTION_FINISH_REASON;
  const continuationModel = shouldContinueWithStandard
    ? AGENT_RUN_SPEND_CAP_STANDARD_CONTINUATION_MODEL
    : undefined;
  const continueButtonLabel = shouldContinueWithStandard
    ? "Continue with Standard"
    : "Continue";

  return (
    <div className="mt-2 w-full">
      <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border flex items-center justify-between gap-3 flex-wrap">
        <span>{content}</span>
        {showContinue && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setHasContinued(true);
              if (finishReason === AGENT_RUN_SPEND_CAP_FINISH_REASON) {
                captureAgentRunSpendCapContinueClick({
                  surface: "finish_reason_notice",
                  source: AGENT_RUN_SPEND_CAP_REASON,
                  finish_reason: finishReason,
                  mode: mode ?? "agent",
                  cap_reason: AGENT_RUN_SPEND_CAP_REASON,
                  premium_continuation_allowed:
                    agentRunSpendCapPremiumContinuationAllowed,
                  continuation_model:
                    continuationModel ?? "current_selected_model",
                });
              }
              onContinue(continuationModel);
            }}
          >
            {continueButtonLabel}
          </Button>
        )}
      </div>
    </div>
  );
};
