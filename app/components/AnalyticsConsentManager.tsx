"use client";

import Link from "next/link";
import { XIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";
import { saveAnalyticsConsent } from "@/app/actions/analytics-consent";
import { PostHogProvider } from "@/app/providers";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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

type AnalyticsConsentPreferencesContextValue = {
  available: boolean;
  consent: AnalyticsConsent | null;
  isSaving: boolean;
  saveError: string | null;
  chooseConsent: (choice: AnalyticsConsent) => Promise<boolean>;
};

const AnalyticsConsentPreferencesContext =
  createContext<AnalyticsConsentPreferencesContextValue | null>(null);

export function useAnalyticsConsentPreferencesAvailable() {
  return useContext(AnalyticsConsentPreferencesContext)?.available ?? false;
}

function ChoiceButtons({
  currentChoice = null,
  disabled,
  onChoose,
}: ChoiceButtonsProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button
        type="button"
        size="sm"
        variant={currentChoice === "declined" ? "secondary" : "outline"}
        disabled={disabled}
        aria-pressed={currentChoice === "declined"}
        onClick={() => onChoose("declined")}
      >
        Decline
      </Button>
      <Button
        type="button"
        size="sm"
        variant={currentChoice === "accepted" ? "secondary" : "outline"}
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
    <p className="text-muted-foreground text-pretty text-sm leading-5">
      We use optional cookies to understand product usage and diagnose errors.
      HackerAI works the same if you decline. Read our{" "}
      <Link
        href="/privacy-policy"
        target="_blank"
        rel="noreferrer"
        className="text-foreground underline underline-offset-4"
      >
        Privacy Policy
      </Link>
      .
    </p>
  );
}

export function AnalyticsConsentPreferences({
  children,
}: {
  children: React.ReactElement;
}) {
  const preferences = useContext(AnalyticsConsentPreferencesContext);
  const [open, setOpen] = useState(false);
  const titleId = useId();

  if (!preferences?.available) return null;

  const chooseConsent = async (choice: AnalyticsConsent) => {
    if (await preferences.chooseConsent(choice)) {
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        aria-labelledby={titleId}
        className="w-[calc(100vw-1.5rem)] max-w-sm rounded-xl p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-sm font-semibold">
              Cookie settings
            </h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {preferences.consent === "accepted"
                ? "Analytics allowed"
                : preferences.consent === "declined"
                  ? "Analytics declined"
                  : "No saved preference"}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close cookie settings"
            className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring rounded-md p-1.5 focus-visible:ring-2 focus-visible:outline-none"
            onClick={() => setOpen(false)}
          >
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </div>
        <ConsentExplanation />
        {preferences.saveError ? (
          <p role="alert" className="text-destructive mt-3 text-sm">
            {preferences.saveError}
          </p>
        ) : null}
        <div className="mt-4">
          <ChoiceButtons
            currentChoice={preferences.consent}
            disabled={preferences.isSaving}
            onChoose={(choice) => void chooseConsent(choice)}
          />
        </div>
      </PopoverContent>
    </Popover>
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
  const [saveError, setSaveError] = useState<string | null>(null);

  const analyticsAllowed = isAnalyticsAllowed({ consent, consentRequired });
  const needsInitialChoice = consentRequired && consent === null;

  const chooseConsent = useCallback(async (choice: AnalyticsConsent) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveAnalyticsConsent(choice);
      setConsent(choice);
      return true;
    } catch {
      setSaveError("We couldn't save your choice. Please try again.");
      return false;
    } finally {
      setIsSaving(false);
    }
  }, []);

  const preferences = useMemo(
    () => ({
      available: consent !== null,
      consent,
      isSaving,
      saveError,
      chooseConsent,
    }),
    [consent, isSaving, saveError, chooseConsent],
  );

  return (
    <AnalyticsConsentPreferencesContext.Provider value={preferences}>
      <PostHogProvider
        analyticsAllowed={analyticsAllowed}
        consentRequired={consentRequired}
        firstTouchAttribution={firstTouchAttribution}
      >
        {children}

        {needsInitialChoice ? (
          <section
            aria-label="Analytics cookie choices"
            className="bg-background/95 fixed inset-x-3 bottom-3 z-[70] ml-auto rounded-xl border p-4 shadow-xl backdrop-blur sm:right-5 sm:bottom-5 sm:left-auto sm:w-[24rem]"
          >
            <h2 className="text-sm font-semibold">Optional analytics</h2>
            <div className="mt-2">
              <ConsentExplanation />
            </div>
            {saveError ? (
              <p role="alert" className="text-destructive mt-3 text-sm">
                {saveError}
              </p>
            ) : null}
            <div className="mt-4">
              <ChoiceButtons
                disabled={isSaving}
                onChoose={(choice) => void chooseConsent(choice)}
              />
            </div>
          </section>
        ) : null}
      </PostHogProvider>
    </AnalyticsConsentPreferencesContext.Provider>
  );
}
