"use client";

import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
import { taskOutcomeProperties } from "@/lib/analytics/task-outcome";
import {
  TASK_OUTCOME_ANSWERS,
  TASK_OUTCOME_REASONS,
  TASK_OUTCOME_READ_DELAY_MS,
  reasonsForAnswer,
  type TaskOutcomeAnswer,
  type TaskOutcomeReason,
} from "@/lib/feedback/task-outcome";

type Survey = Doc<"task_outcome_surveys">;
function captureSurvey(event: string, row: Survey) {
  captureQueuedAuthenticatedEvent({
    event: `task_outcome_survey_${event}`,
    properties: taskOutcomeProperties(row),
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
    isAuthenticated ? { chat_id: chatId, message_id: messageId } : "skip",
  );
  const record = useMutation(api.taskOutcomeSurveys.record);
  if (!isAuthenticated) return null;
  return (
    <TaskOutcomeFeedbackPrompt
      key={messageId}
      survey={survey}
      record={record}
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
    action: "shown" | "dismissed" | "answered" | "reason";
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
      survey.shown_at ||
      survey.answered_at ||
      survey.dismissed_at ||
      claimed.current ||
      hidden
    )
      return;
    const element = anchor.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    let intersecting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!intersecting || document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        if (survey.expires_at <= Date.now() || claimed.current) return;
        claimed.current = true;
        void record({ id: survey._id, action: "shown" })
          .then((row) => {
            if (mounted.current && row) setVisibleSurvey(row);
          })
          .catch(() => {
            /* Fail closed; never interrupt the chat. */
          });
      }, TASK_OUTCOME_READ_DELAY_MS);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        intersecting = entries.some((entry) => entry.isIntersecting);
        schedule();
      },
      { threshold: 1 },
    );
    observer.observe(element);
    document.addEventListener("visibilitychange", schedule);
    // Give composing users another quiet interval instead of asking mid-typing.
    document.addEventListener("input", schedule);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("input", schedule);
    };
  }, [survey, record, hidden]);

  useEffect(() => {
    if (!visibleSurvey || !question.current || hidden) return;
    // The visibility event measures the rendered question, not the selection or
    // the cross-device claim. Hidden tabs never count as actual question views.
    const element = question.current;
    let visible = false;
    const capture = () => {
      if (visible && document.visibilityState === "visible")
        captureSurvey("shown", visibleSurvey);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
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
  }, [visibleSurvey, hidden]);

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
      if (value === "not_checked") setDone(true);
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
      className="relative mt-2 mb-3 max-w-xl rounded-lg border border-border px-3 py-2 text-sm"
      role="group"
      aria-label="Optional task feedback"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1 size-7 text-muted-foreground"
        aria-label="Dismiss task feedback"
        onClick={dismiss}
        disabled={busy}
      >
        <X className="size-3.5" />
      </Button>
      {done ? (
        <p className="pr-7 text-muted-foreground">Thanks for the feedback.</p>
      ) : (
        <>
          <p className="pr-7">
            {answer
              ? answer === "yes"
                ? "What helped?"
                : "What could be better?"
              : "Did this run help you accomplish what you wanted?"}
            <span className="ml-2 text-xs text-muted-foreground">Optional</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {answer
              ? reasonsForAnswer(answer).map((reason) => (
                  <Button
                    type="button"
                    key={reason}
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-full text-xs"
                    disabled={busy}
                    onClick={() => void saveReason(reason)}
                  >
                    {TASK_OUTCOME_REASONS[reason]}
                  </Button>
                ))
              : Object.entries(TASK_OUTCOME_ANSWERS).map(([value, label]) => (
                  <Button
                    type="button"
                    key={value}
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-full text-xs"
                    disabled={busy}
                    onClick={() => void saveAnswer(value as TaskOutcomeAnswer)}
                  >
                    {label}
                  </Button>
                ))}
            {answer && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => setDone(true)}
                disabled={busy}
              >
                Skip
              </Button>
            )}
          </div>
          {error && (
            <p className="mt-2 text-xs text-muted-foreground">
              Couldn’t save. Try again when you’re ready.
            </p>
          )}
        </>
      )}
    </div>
  );
}
