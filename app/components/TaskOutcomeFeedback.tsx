"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Check, Minus, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
import { taskOutcomeProperties } from "@/lib/analytics/task-outcome";
import { AGENT_CONTEXT_FEEDBACK_CLIENT_VERSION } from "@/lib/feedback/agent-context";
import {
  PAID_TASK_OUTCOME_ANSWERS,
  TASK_OUTCOME_REASONS,
  reasonsForAnswer,
  type TaskOutcomeAnswer,
  type TaskOutcomeReason,
  PRO_THREE_STEPS_TASK_OUTCOME_PHASE,
} from "@/lib/feedback/task-outcome";

type Survey = Doc<"task_outcome_surveys">;
function isPersistentProFeedback(row: Survey) {
  return (
    row.survey_kind === "current_experiment" &&
    row.feedback_phase === PRO_THREE_STEPS_TASK_OUTCOME_PHASE
  );
}

function captureSurvey(event: string, row: Survey) {
  const commit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  captureQueuedAuthenticatedEvent({
    event: `task_outcome_survey_${event}`,
    properties: {
      ...taskOutcomeProperties(row),
      survey_ui_version: isPersistentProFeedback(row) ? 5 : 4,
      ...((row.survey_kind === "agent_context" ||
        isPersistentProFeedback(row)) &&
        /^[a-f0-9]{40}$/i.test(commit ?? "") && {
          hackerai_frontend_build_commit: commit,
        }),
    },
    dedupeKey: `${row._id}:${event}`,
  });
}

export function TaskOutcomeFeedback({
  chatId,
  messageId,
}: {
  chatId: string;
  messageId: string;
}) {
  const { isAuthenticated } = useConvexAuth();
  const survey = useQuery(
    api.taskOutcomeSurveys.getForMessage,
    isAuthenticated
      ? {
          chat_id: chatId,
          message_id: messageId,
          context_feedback_version: AGENT_CONTEXT_FEEDBACK_CLIENT_VERSION,
        }
      : "skip",
  );
  const record = useMutation(api.taskOutcomeSurveys.record);
  const recordCompatible = useCallback(
    (args: Parameters<typeof record>[0]) =>
      record({
        ...args,
        context_feedback_version: AGENT_CONTEXT_FEEDBACK_CLIENT_VERSION,
      }),
    [record],
  );
  if (!isAuthenticated) return null;
  return (
    <TaskOutcomeFeedbackPrompt
      key={messageId}
      survey={survey}
      record={recordCompatible}
    />
  );
}

// Separated from data fetching so the real timing, focus, and keyboard behavior
// can be exercised without a live provider or user account.
export function TaskOutcomeFeedbackPrompt({
  survey,
  record,
}: {
  survey: Survey | null | undefined;
  record: (args: {
    id: Survey["_id"];
    action: "shown" | "viewed" | "dismissed" | "answered" | "reason";
    answer?: TaskOutcomeAnswer;
    reason?: TaskOutcomeReason;
  }) => Promise<Survey | null>;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const question = useRef<HTMLDivElement>(null);
  const claimed = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [visibleSurvey, setVisibleSurvey] = useState<Survey | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [answer, setAnswer] = useState<TaskOutcomeAnswer>();
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (
      !survey ||
      survey.answered_at ||
      survey.dismissed_at ||
      survey.expires_at <= Date.now() ||
      claimed.current ||
      hidden
    )
      return;
    if (survey.shown_at) {
      // A view is not an answer. Keep the same Pro invitation available when
      // users return after trying the result; the server still owns deduplication.
      if (isPersistentProFeedback(survey)) {
        claimed.current = true;
        setVisibleSurvey(survey);
      }
      return;
    }
    const element = anchor.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    let intersecting = false;
    const show = () => {
      if (
        !intersecting ||
        document.visibilityState !== "visible" ||
        survey.expires_at <= Date.now() ||
        claimed.current
      )
        return;
      claimed.current = true;
      void record({ id: survey._id, action: "shown" })
        .then((row) => {
          if (mounted.current && row) setVisibleSurvey(row);
        })
        .catch(() => {
          /* Fail closed; never interrupt the chat. */
        });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        intersecting = entries.some(
          (entry) => entry.isIntersecting && entry.intersectionRatio >= 1,
        );
        show();
      },
      { threshold: 1 },
    );
    observer.observe(element);
    document.addEventListener("visibilitychange", show);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", show);
    };
  }, [survey, record, hidden]);

  useEffect(() => {
    if (!visibleSurvey || !question.current || hidden) return;
    // The visibility event measures the rendered question, not the selection or
    // the cross-device claim. Hidden tabs never count as actual question views.
    const element = question.current;
    let visible = false;
    let recorded = false;
    const capture = () => {
      if (!visible || document.visibilityState !== "visible") return;
      captureSurvey("shown", visibleSurvey);
      if (!recorded) {
        recorded = true;
        void record({ id: visibleSurvey._id, action: "viewed" }).catch(() => {
          recorded = false;
        });
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some(
          (entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5,
        );
        capture();
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    document.addEventListener("visibilitychange", capture);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", capture);
    };
  }, [visibleSurvey, hidden, record]);

  if (hidden) return null;
  if (!visibleSurvey)
    return survey && !survey.shown_at ? (
      <div ref={anchor} className="h-px" aria-hidden="true" />
    ) : null;

  const saveAnswer = async (value: TaskOutcomeAnswer) => {
    setBusy(true);
    setError(false);
    try {
      const row = await record({
        id: visibleSurvey._id,
        action: "answered",
        answer: value,
      });
      if (!row) {
        setHidden(true);
        return;
      }
      captureSurvey("answered", row);
      setAnswer(value);
      if (value === "solved" || value === "not_checked") setDone(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const saveReason = async (reason: TaskOutcomeReason) => {
    setBusy(true);
    setError(false);
    try {
      const row = await record({
        id: visibleSurvey._id,
        action: "reason",
        reason,
      });
      if (!row) {
        setHidden(true);
        return;
      }
      captureSurvey("reason", row);
      setDone(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    setHidden(true);
    if (answer) return;
    void record({ id: visibleSurvey._id, action: "dismissed" })
      .then((row) => {
        if (row) captureSurvey("dismissed", row);
      })
      .catch(() => {});
  };

  return (
    <div
      ref={question}
      className={`relative mb-3 mt-2 flex w-full max-w-full flex-wrap items-center gap-x-4 gap-y-2 text-sm ${isPersistentProFeedback(visibleSurvey) ? "rounded-xl border border-border bg-muted/30 p-4 pr-14" : `pr-11 sm:pr-9 ${answer ? "sm:max-w-sm" : "sm:w-fit"}`}`}
      role="group"
      aria-label="Task feedback"
    >
      <div className="flex min-h-[44px] items-center sm:min-h-8">
        <p
          className="text-sm text-muted-foreground"
          role={done ? "status" : undefined}
        >
          {done
            ? "Thanks for your feedback"
            : answer
              ? answer === "helpful"
                ? "What helped?"
                : "What could be better?"
              : isPersistentProFeedback(visibleSurvey)
                ? "Did this help with your task?"
                : "Did this help?"}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={`absolute size-[44px] rounded-full text-muted-foreground/70 hover:text-foreground sm:size-8 ${isPersistentProFeedback(visibleSurvey) ? "right-1 top-1" : "right-0 top-0"}`}
          aria-label="Dismiss task feedback"
          onClick={dismiss}
          disabled={busy}
        >
          <X className="size-4" />
        </Button>
      </div>
      {isPersistentProFeedback(visibleSurvey) && !answer && (
        <p className="basis-full text-xs text-muted-foreground">
          Answer when you’ve tried the result. Your feedback helps improve
          answers.
        </p>
      )}
      {!done && (
        <>
          {answer ? (
            <div className="flex basis-full flex-wrap gap-2">
              {reasonsForAnswer(answer).map((reason) => (
                <Button
                  type="button"
                  key={reason}
                  variant="outline"
                  size="sm"
                  className="min-h-[44px] h-auto max-w-full whitespace-normal rounded-full px-3 py-2 text-xs sm:min-h-8 sm:py-1"
                  disabled={busy}
                  onClick={() => void saveReason(reason)}
                >
                  {TASK_OUTCOME_REASONS[reason]}
                </Button>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-[44px] px-3 text-xs text-muted-foreground sm:h-8"
                onClick={() => setDone(true)}
                disabled={busy}
              >
                Skip
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {(["solved", "helpful", "no", "not_checked"] as const).map(
                (value) => {
                  const Icon =
                    value === "solved"
                      ? Check
                      : value === "helpful" || value === "not_checked"
                        ? Minus
                        : X;
                  return (
                    <Button
                      type="button"
                      key={value}
                      variant="outline"
                      size="sm"
                      className="h-[44px] gap-1.5 rounded-full border-border/70 bg-transparent px-3 text-xs font-normal shadow-none hover:border-foreground/30 hover:bg-muted/60 sm:h-8"
                      disabled={busy}
                      onClick={() => void saveAnswer(value)}
                    >
                      <Icon
                        className="size-3.5 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {PAID_TASK_OUTCOME_ANSWERS[value]}
                    </Button>
                  );
                },
              )}
            </div>
          )}
          {error && (
            <p
              className="basis-full text-xs text-muted-foreground"
              role="status"
            >
              Couldn’t save. Try again when you’re ready.
            </p>
          )}
        </>
      )}
    </div>
  );
}
