import { useRef, useState } from "react";
import { toast } from "sonner";
import { ChatMode } from "@/types/chat";
import { useDataStreamState } from "@/app/components/DataStreamProvider";
import { Button } from "@/components/ui/button";
import { AGENT_RUN_SPEND_CAP_FINISH_REASON } from "@/lib/chat/agent-run-spend-cap";
import {
  BUDGET_EXHAUSTION_FINISH_REASON,
  STEP_LIMIT_FINISH_REASON,
  CLIENT_SAVED_FINISH_REASON,
  OUTPUT_LIMIT_FINISH_REASON,
  POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import type { SelectedModel } from "@/types/chat";
import { BudgetExhaustedNotice } from "./BudgetExhaustedNotice";

interface FinishReasonNoticeProps {
  finishReason?: string;
  mode?: ChatMode;
  agentRunSpendCapPremiumContinuationAllowed?: boolean;
  onContinue?: (selectedModelOverride?: SelectedModel) => void | Promise<void>;
}

export const FinishReasonNotice = ({
  finishReason,
  onContinue,
}: FinishReasonNoticeProps) => {
  const { isAutoResuming, isAutoContinuing } = useDataStreamState();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const resume = async (selectedModelOverride?: SelectedModel) => {
    if (!onContinue || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await onContinue(selectedModelOverride);
    } catch {
      toast.error("Could not resume. Your saved progress is still available.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  if (!finishReason) return null;

  if (isAutoContinuing) {
    return (
      <div className="mt-2 w-full" role="status" aria-live="polite">
        <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border">
          Continuing automatically…
        </div>
      </div>
    );
  }

  if (isAutoResuming) return null;

  if (finishReason === BUDGET_EXHAUSTION_FINISH_REASON) {
    // A manual attempt goes through normal server admission and resumes the
    // existing task. It does not regenerate completed work or bypass billing.
    return (
      <BudgetExhaustedNotice
        onContinue={onContinue ? resume : undefined}
        pending={pending}
      />
    );
  }

  const getNoticeContent = () => {
    if (
      finishReason === STEP_LIMIT_FINISH_REASON ||
      finishReason === "tool-calls"
    ) {
      return (
        <>Reached the step limit for this turn. Completed work was saved.</>
      );
    }

    if (finishReason === CLIENT_SAVED_FINISH_REASON) {
      return <>Agent stopped unexpectedly. Saved progress is available.</>;
    }

    if (finishReason === "timeout" || finishReason === "preemptive-timeout") {
      return (
        <>Reached the time limit for this turn. Completed work was saved.</>
      );
    }

    if (finishReason === OUTPUT_LIMIT_FINISH_REASON) {
      return (
        <>
          The response reached its output limit before finishing. Continue to
          resume where it stopped; completed work was saved.
        </>
      );
    }

    if (finishReason === "context-limit") {
      return (
        <>
          Reached the context limit for this conversation. Completed work was
          saved.
        </>
      );
    }

    if (finishReason === POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON) {
      return (
        <>Paused after compacting the conversation. Completed work was saved.</>
      );
    }

    if (finishReason === AGENT_RUN_SPEND_CAP_FINISH_REASON) {
      return <>Paused at a legacy Pro Agent per-run safety cap.</>;
    }

    return null;
  };

  const content = getNoticeContent();

  if (!content) return null;

  const showContinue = !!onContinue;
  const continueButtonLabel =
    finishReason === CLIENT_SAVED_FINISH_REASON ? "Resume task" : "Continue";

  return (
    <div className="mt-2 w-full">
      <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border flex items-center justify-between gap-3 flex-wrap">
        <span>{content}</span>
        {showContinue && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void resume()}
          >
            {pending ? "Resuming…" : continueButtonLabel}
          </Button>
        )}
      </div>
    </div>
  );
};
