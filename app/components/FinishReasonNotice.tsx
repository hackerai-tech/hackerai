import type { LimitRescueRequest } from "@/types/chat";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { LOCAL_CONNECTION_LOST_FINISH_REASON } from "@/lib/chat/local-connection-stop";
import type { ChatStatus } from "@/types";
import { ChatMode } from "@/types/chat";
import { useDataStreamState } from "@/app/components/DataStreamProvider";
import { Button } from "@/components/ui/button";
import { AGENT_RUN_SPEND_CAP_FINISH_REASON } from "@/lib/chat/agent-run-spend-cap";
import {
  BUDGET_EXHAUSTION_FINISH_REASON,
  DOOM_LOOP_FINISH_REASON,
  STEP_LIMIT_FINISH_REASON,
  CLIENT_SAVED_FINISH_REASON,
  OUTPUT_LIMIT_FINISH_REASON,
  POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import type { SelectedModel } from "@/types/chat";
import { BudgetExhaustedNotice } from "./BudgetExhaustedNotice";

interface FinishReasonNoticeProps {
  finishReason?: string;
  continueDisabledReason?: string;
  status?: ChatStatus;
  mode?: ChatMode;
  agentRunSpendCapPremiumContinuationAllowed?: boolean;
  onContinue?: (
    selectedModelOverride?: SelectedModel,
    limitRescue?: LimitRescueRequest,
  ) => void | Promise<void>;
}

export const FinishReasonNotice = ({
  finishReason,
  mode,
  onContinue,
  continueDisabledReason,
  status,
}: FinishReasonNoticeProps) => {
  const { isAutoResuming, isAutoContinuing } = useDataStreamState();
  const pendingRef = useRef(false);
  const disabledReasonId = useId();
  const [pending, setPending] = useState(false);
  const resume = async (
    selectedModelOverride?: SelectedModel,
    limitRescue?: LimitRescueRequest,
  ) => {
    if (!onContinue || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      if (limitRescue) await onContinue(selectedModelOverride, limitRescue);
      else await onContinue(selectedModelOverride);
    } catch {
      toast.error("Could not resume. Your saved progress is still available.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  if (!finishReason) return null;

  if (finishReason === LOCAL_CONNECTION_LOST_FINISH_REASON) {
    if (status === "streaming") return null;
    const disabledReason =
      continueDisabledReason ||
      (mode === "ask" ? "Switch to Agent to resume." : undefined);
    const resuming = pending || status === "submitted";
    return (
      <div className="mt-2 w-full" role="status" aria-live="polite">
        <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1 basis-60">
            <p>
              The connection to your computer was lost, so this run stopped.
            </p>
            <p className="mt-1 text-sm">
              Saved progress is available. A command that was running may not
              have finished.
            </p>
            {disabledReason && (
              <p id={disabledReasonId} className="mt-1 text-sm">
                {disabledReason}
              </p>
            )}
          </div>
          {onContinue && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-w-26 text-foreground"
              disabled={!!disabledReason || resuming}
              aria-busy={resuming}
              aria-describedby={disabledReason ? disabledReasonId : undefined}
              onClick={() => void resume()}
            >
              {resuming ? "Resuming…" : "Resume"}
            </Button>
          )}
        </div>
      </div>
    );
  }

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
        mode={mode}
      />
    );
  }

  const getNoticeContent = () => {
    if (finishReason === DOOM_LOOP_FINISH_REASON) {
      return (
        <>
          Agent stopped after repeating work without progress. Send a new
          instruction to change the approach.
        </>
      );
    }

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

  // Replaying an unchanged request can restart the cycle that was just halted.
  const showContinue = !!onContinue && finishReason !== DOOM_LOOP_FINISH_REASON;
  const continueButtonLabel =
    finishReason === CLIENT_SAVED_FINISH_REASON ? "Resume task" : "Continue";

  return (
    <div className="mt-2 w-full" role="status">
      <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border flex items-center justify-between gap-3 flex-wrap">
        <span>{content}</span>
        {showContinue && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              pending || !!continueDisabledReason || status === "submitted"
            }
            onClick={() => void resume()}
          >
            {pending ? "Resuming…" : continueButtonLabel}
          </Button>
        )}
      </div>
    </div>
  );
};
