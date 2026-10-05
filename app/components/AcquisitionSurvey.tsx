"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { v5 as uuidv5 } from "uuid";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGlobalState } from "../contexts/GlobalState";
import {
  ACQUISITION_SURVEY_STORAGE_KEY,
  ACQUISITION_SURVEY_VERSION,
  USE_CASE_SURVEY_STORAGE_KEY,
  USE_CASE_QUESTION,
  USE_CASE_OPTIONS,
  isNewSurveyUser,
  useCaseSurveySchema,
  type UseCaseAnswer,
  type UseCaseSurvey,
  type SurveyActivationMode,
} from "@/lib/analytics/acquisition-survey";
import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";

const completedInSession = new Set<string>();
const storageKey = (userId: string) =>
  `${USE_CASE_SURVEY_STORAGE_KEY}:${userId}`;
function hasSeenSurvey(userId: string) {
  if (completedInSession.has(userId)) return true;
  try {
    return Boolean(
      window.localStorage.getItem(storageKey(userId)) ||
      window.localStorage.getItem(ACQUISITION_SURVEY_STORAGE_KEY),
    );
  } catch {
    return false;
  }
}
function rememberSurvey(userId: string, value: string) {
  completedInSession.add(userId);
  try {
    window.localStorage.setItem(storageKey(userId), value);
  } catch {
    // Browser-local suppression remains best effort when storage is blocked.
  }
}

/** PostHog owns definitions/responses. The app owns the safe display moment. */
export function AcquisitionSurvey({
  activationMode,
}: {
  activationMode: SurveyActivationMode;
}) {
  const { user, organizationId } = useAuth();
  const { subscription } = useGlobalState();
  const analyticsUserId = useSyncExternalStore(
    subscribeAuthenticatedAnalytics,
    getIdentifiedAnalyticsUserId,
    () => null,
  );
  const userId = user?.id;
  const eligible = Boolean(
    userId &&
    analyticsUserId === userId &&
    !organizationId &&
    subscription === "free" &&
    user?.createdAt &&
    isNewSurveyUser(user.createdAt),
  );
  if (!eligible || !userId) return null;
  return (
    <AvailableAcquisitionSurvey
      key={userId}
      userId={userId}
      activationMode={activationMode}
    />
  );
}

function AvailableAcquisitionSurvey({
  userId,
  activationMode,
}: {
  userId: string;
  activationMode: SurveyActivationMode;
}) {
  const [survey, setSurvey] = useState<UseCaseSurvey | null>(null);
  useEffect(() => {
    if (hasSeenSurvey(userId)) return;
    const controller = new AbortController();
    // A fetch or SDK callback must never keep a stale invitation alive after
    // navigation, a new run, identity change, or consent withdrawal.
    void fetch("/api/experiments/acquisition-survey", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok || controller.signal.aborted) return;
        const body = await response.json();
        const parsed = useCaseSurveySchema.safeParse(body.survey);
        if (
          controller.signal.aborted ||
          body.available !== true ||
          !parsed.success ||
          getIdentifiedAnalyticsUserId() !== userId ||
          hasSeenSurvey(userId)
        )
          return;
        setSurvey(parsed.data);
      })
      .catch(() => {
        /* Research must never interrupt chat. */
      });
    return () => controller.abort();
  }, [userId]);
  return survey ? (
    <AcquisitionSurveyPrompt
      survey={survey}
      userId={userId}
      activationMode={activationMode}
    />
  ) : null;
}

export function AcquisitionSurveyPrompt({
  survey,
  userId,
  activationMode,
}: {
  survey: UseCaseSurvey;
  userId: string;
  activationMode: SurveyActivationMode;
}) {
  const card = useRef<HTMLElement>(null);
  const shown = useRef(false);
  const completed = useRef(false);
  const [state, setState] = useState<"visible" | "answered" | "dismissed">(
    "visible",
  );
  const [captureFailed, setCaptureFailed] = useState(false);
  const submissionId = uuidv5(`${userId}:${survey.id}`, uuidv5.URL);
  const capture = useCallback(
    (
      event: "survey shown" | "survey sent" | "survey dismissed",
      answer?: UseCaseAnswer,
    ) => {
      if (getIdentifiedAnalyticsUserId() !== userId) return false;
      const label = USE_CASE_OPTIONS.find(
        (option) => option.value === answer,
      )?.label;
      return captureQueuedAuthenticatedEvent({
        event,
        dedupeKey: survey.id,
        properties: {
          $survey_id: survey.id,
          $survey_submission_id: submissionId,
          $survey_questions: [
            { id: survey.questionId, question: USE_CASE_QUESTION },
          ],
          survey_version: ACQUISITION_SURVEY_VERSION,
          activation_mode: activationMode,
          ...(answer && {
            $survey_completed: true,
            [`$survey_response_${survey.questionId}`]: label,
            use_case: answer,
          }),
          ...(event !== "survey shown" && {
            $set_once: {
              marketing_use_case_survey_completed_v2: true,
              [answer
                ? `$survey_responded/${survey.id}`
                : `$survey_dismissed/${survey.id}`]: true,
              ...(answer && { marketing_use_case_v2: answer }),
            },
          }),
        },
      });
    },
    [activationMode, submissionId, survey.id, survey.questionId, userId],
  );

  useEffect(() => {
    if (!card.current || typeof IntersectionObserver === "undefined") return;
    let inView = false;
    const view = () => {
      if (shown.current || !inView || document.visibilityState !== "visible")
        return;
      if (capture("survey shown")) {
        shown.current = true;
        rememberSurvey(userId, "shown");
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        inView = entries.some(
          (entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5,
        );
        view();
      },
      { threshold: 0.5 },
    );
    observer.observe(card.current);
    document.addEventListener("visibilitychange", view);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey(userId) && event.newValue) {
        completed.current = true;
        setState("dismissed");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", view);
      window.removeEventListener("storage", onStorage);
    };
  }, [capture, userId]);

  const finish = (answer?: UseCaseAnswer) => {
    if (completed.current) return;
    // A keyboard interaction also proves actual exposure, even before the
    // observer's callback. Never count a submission without a shown event.
    if (!shown.current) {
      if (!capture("survey shown")) {
        setCaptureFailed(true);
        return;
      }
      shown.current = true;
    }
    if (!capture(answer ? "survey sent" : "survey dismissed", answer)) {
      setCaptureFailed(true);
      return;
    }
    completed.current = true;
    rememberSurvey(userId, answer ? "answered" : "dismissed");
    setState(answer ? "answered" : "dismissed");
  };
  if (state === "dismissed") return null;
  if (state === "answered")
    return (
      <p role="status" className="mt-4 text-sm text-muted-foreground">
        Thanks for sharing.
      </p>
    );
  return (
    <aside
      ref={card}
      aria-label="Optional use case survey"
      className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{USE_CASE_QUESTION}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Optional · Help us make better guides and examples.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => finish()}
          aria-label="Dismiss survey"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div
        role="group"
        aria-label={USE_CASE_QUESTION}
        className="mt-3 flex flex-wrap gap-2"
      >
        {USE_CASE_OPTIONS.map(({ value, label }) => (
          <Button
            key={value}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto min-h-9 max-w-full whitespace-normal text-left"
            onClick={() => finish(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {captureFailed && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Couldn’t record your response. Please try again.
        </p>
      )}
    </aside>
  );
}
