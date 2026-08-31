"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { saveAnalyticsConsent } from "@/app/actions/analytics-consent";
import { PostHogProvider } from "@/app/providers";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FirstTouchAttribution } from "@/lib/analytics/acquisition";
import {
  type AnalyticsConsent,
  isAnalyticsAllowed,
} from "@/lib/privacy/analytics-consent";

type AnalyticsConsentManagerProps = {
  children: React.ReactNode;
  consentRequired: boolean;
  firstTouchAttribution?: FirstTouchAttribution | null;
  initialConsent: AnalyticsConsent | null;
};

type ChoiceButtonsProps = {
  currentChoice?: AnalyticsConsent | null;
  disabled: boolean;
  onChoose: (choice: AnalyticsConsent) => void;
};

function ChoiceButtons({
  currentChoice = null,
  disabled,
  onChoose,
}: ChoiceButtonsProps) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button
        type="button"
        variant={currentChoice === "declined" ? "secondary" : "outline"}
        className="min-w-36 flex-1"
        disabled={disabled}
        aria-pressed={currentChoice === "declined"}
        onClick={() => onChoose("declined")}
      >
        Reject analytics
      </Button>
      <Button
        type="button"
        variant={currentChoice === "accepted" ? "secondary" : "outline"}
        className="min-w-36 flex-1"
        disabled={disabled}
        aria-pressed={currentChoice === "accepted"}
        onClick={() => onChoose("accepted")}
      >
        Allow analytics
      </Button>
    </div>
  );
}

function ConsentExplanation() {
  return (
    <p className="text-muted-foreground text-sm leading-6">
      HackerAI uses optional browser storage for PostHog product analytics,
      diagnostics, and—on eligible paid accounts—session replay. Rejecting
      analytics will not affect the service. Read our{" "}
      <Link
        href="/privacy-policy"
        target="_blank"
        className="text-foreground underline underline-offset-4"
      >
        Privacy Policy
      </Link>
      .
    </p>
  );
}

export function AnalyticsConsentManager({
  children,
  consentRequired,
  firstTouchAttribution = null,
  initialConsent,
}: AnalyticsConsentManagerProps) {
  const [consent, setConsent] = useState(initialConsent);
  const [isSaving, setIsSaving] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const analyticsAllowed = isAnalyticsAllowed({
    consent,
    consentRequired,
  });
  const needsInitialChoice = consentRequired && consent === null;

  const chooseConsent = async (choice: AnalyticsConsent) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveAnalyticsConsent(choice);
      setConsent(choice);
      setPreferencesOpen(false);
    } catch {
      setSaveError("We couldn't save your privacy choice. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <PostHogProvider
      analyticsAllowed={analyticsAllowed}
      firstTouchAttribution={firstTouchAttribution}
    >
      {children}

      {needsInitialChoice ? (
        <section
          aria-label="Analytics privacy choices"
          className="fixed inset-x-3 bottom-3 z-[70] mx-auto max-w-3xl rounded-2xl border border-border bg-background/95 p-4 shadow-2xl backdrop-blur sm:bottom-5 sm:p-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 gap-3">
              <span className="mt-0.5 rounded-full border border-border bg-muted p-2 text-foreground">
                <ShieldCheck aria-hidden="true" className="size-4" />
              </span>
              <div className="space-y-2">
                <h2 className="text-base font-semibold">
                  Your analytics choice
                </h2>
                <ConsentExplanation />
                {saveError ? (
                  <p role="alert" className="text-destructive text-sm">
                    {saveError}
                  </p>
                ) : null}
              </div>
            </div>
            <ChoiceButtons
              disabled={isSaving}
              onChoose={(choice) => void chooseConsent(choice)}
            />
          </div>
        </section>
      ) : null}

      {!needsInitialChoice && (consentRequired || consent !== null) ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="fixed bottom-3 left-3 z-50 bg-background/90 text-xs shadow-md backdrop-blur"
          onClick={() => setPreferencesOpen(true)}
        >
          Privacy choices
        </Button>
      ) : null}

      <Dialog open={preferencesOpen} onOpenChange={setPreferencesOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Analytics privacy choices</DialogTitle>
            <DialogDescription asChild>
              <ConsentExplanation />
            </DialogDescription>
          </DialogHeader>
          {saveError ? (
            <p role="alert" className="text-destructive text-sm">
              {saveError}
            </p>
          ) : null}
          <ChoiceButtons
            currentChoice={consent}
            disabled={isSaving}
            onChoose={(choice) => void chooseConsent(choice)}
          />
        </DialogContent>
      </Dialog>
    </PostHogProvider>
  );
}
