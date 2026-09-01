"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ACQUISITION_SURVEY_ID,
  ACQUISITION_SURVEY_STORAGE_KEY,
  ACQUISITION_SURVEY_VERSION,
  FIRST_HEARD_OPTIONS,
  MAIN_REASON_OPTIONS,
  type FirstHeardAnswer,
  type MainReasonAnswer,
  type SurveyActivationMode,
} from "@/lib/analytics/acquisition-survey";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";

type SurveyState = "idle" | "visible" | "complete";

function hasCompletedSurveyInStorage() {
  try {
    return Boolean(window.localStorage.getItem(ACQUISITION_SURVEY_STORAGE_KEY));
  } catch {
    return false;
  }
}

function storeSurveyCompletion(value: "dismissed" | "submitted") {
  try {
    window.localStorage.setItem(ACQUISITION_SURVEY_STORAGE_KEY, value);
  } catch {
    // Storage may be blocked or full; the survey should still close and record.
  }
}

export function AcquisitionSurvey({
  eligible,
  activationMode,
}: {
  eligible: boolean;
  activationMode: SurveyActivationMode;
}) {
  const [state, setState] = useState<SurveyState>("idle");
  const hasCheckedAvailabilityRef = useRef(false);
  const [firstHeard, setFirstHeard] = useState<FirstHeardAnswer | "">("");
  const [mainReason, setMainReason] = useState<MainReasonAnswer | "">("");

  useEffect(() => {
    if (!eligible || hasCheckedAvailabilityRef.current) return;
    hasCheckedAvailabilityRef.current = true;
    if (hasCompletedSurveyInStorage()) {
      return;
    }

    const controller = new AbortController();
    void fetch("/api/experiments/acquisition-survey", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const body = (await response.json()) as { available?: unknown };
        return body.available === true;
      })
      .then((available) => {
        if (!available) {
          setState("complete");
          return;
        }
        setState("visible");
        captureQueuedAuthenticatedEvent({
          event: "acquisition_survey_shown",
          dedupeKey: ACQUISITION_SURVEY_ID,
          properties: {
            survey_id: ACQUISITION_SURVEY_ID,
            survey_version: ACQUISITION_SURVEY_VERSION,
            activation_mode: activationMode,
          },
        });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setState("complete");
        }
      });

    return () => controller.abort();
  }, [activationMode, eligible]);

  const dismiss = () => {
    storeSurveyCompletion("dismissed");
    setState("complete");
    captureQueuedAuthenticatedEvent({
      event: "acquisition_survey_dismissed",
      dedupeKey: ACQUISITION_SURVEY_ID,
      properties: {
        survey_id: ACQUISITION_SURVEY_ID,
        survey_version: ACQUISITION_SURVEY_VERSION,
        activation_mode: activationMode,
      },
    });
  };

  const submit = () => {
    if (!firstHeard || !mainReason) return;
    const answeredAt = new Date().toISOString();
    storeSurveyCompletion("submitted");
    setState("complete");
    captureQueuedAuthenticatedEvent({
      event: "acquisition_survey_submitted",
      dedupeKey: ACQUISITION_SURVEY_ID,
      properties: {
        survey_id: ACQUISITION_SURVEY_ID,
        survey_version: ACQUISITION_SURVEY_VERSION,
        activation_mode: activationMode,
        answer_source: "post_activation_survey",
        first_heard_source: firstHeard,
        main_reason: mainReason,
        $set_once: {
          acquisition_survey_first_heard: firstHeard,
          acquisition_survey_main_reason: mainReason,
          acquisition_survey_answered_at: answeredAt,
          acquisition_survey_version: ACQUISITION_SURVEY_VERSION,
        },
      },
    });
  };

  if (state !== "visible") return null;

  return (
    <aside
      className="fixed right-4 bottom-24 z-40 w-[calc(100%-2rem)] max-w-sm rounded-lg border border-border bg-background p-5 shadow-xl"
      aria-labelledby="acquisition-survey-title"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="acquisition-survey-title" className="font-semibold">
            Help us improve discovery
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Two quick questions about how you found HackerAI.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={dismiss}
          aria-label="Dismiss survey"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="mt-5 space-y-4">
        <label className="block text-sm font-medium" htmlFor="first-heard">
          Where did you first hear about HackerAI?
        </label>
        <select
          id="first-heard"
          value={firstHeard}
          onChange={(event) =>
            setFirstHeard(event.target.value as FirstHeardAnswer)
          }
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <option value="" disabled>
            Select one
          </option>
          {FIRST_HEARD_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="block text-sm font-medium" htmlFor="main-reason">
          What was your main reason for trying it?
        </label>
        <select
          id="main-reason"
          value={mainReason}
          onChange={(event) =>
            setMainReason(event.target.value as MainReasonAnswer)
          }
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <option value="" disabled>
            Select one
          </option>
          {MAIN_REASON_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <Button
        type="button"
        className="mt-5 w-full"
        disabled={!firstHeard || !mainReason}
        onClick={submit}
      >
        Submit
      </Button>
    </aside>
  );
}
