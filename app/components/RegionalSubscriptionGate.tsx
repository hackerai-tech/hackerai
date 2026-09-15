"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useUpgrade } from "@/app/hooks/useUpgrade";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  REGIONAL_SUBSCRIPTION_FIRST_EXPOSURE,
  isSubscriptionFirstCountry,
  regionalSubscriptionProperties,
  type RegionalSubscriptionAssignment,
} from "@/lib/experiments/regional-subscription-first";
import {
  PRO_MONTHLY_PRICING_EXPOSURE_EVENT,
  proMonthlyPricingAssignmentForVariant,
  proMonthlyPricingExperimentProperties,
  type ProMonthlyPricingExperimentPresentation,
} from "@/lib/experiments/pro-monthly-pricing";

function SubscriptionOffer({
  assignment,
}: {
  assignment: RegionalSubscriptionAssignment;
}) {
  const { handleUpgrade, upgradeLoading } = useUpgrade();
  const [price, setPrice] = useState<ProMonthlyPricingExperimentPresentation>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let active = true;
    void fetch("/api/pricing/pro-monthly-experiment", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Price unavailable");
        const value = await response.json();
        const expected = proMonthlyPricingAssignmentForVariant(
          value.variant === "test" ? "test" : "control",
        );
        if (
          value.key !== expected.key ||
          value.priceLookupKey !== expected.priceLookupKey ||
          value.displayedAmountDollars !== expected.displayedAmountDollars ||
          typeof value.stripePriceId !== "string" ||
          !value.stripePriceId
        )
          throw new Error("Invalid price");
        if (active)
          setPrice({ ...expected, stripePriceId: value.stripePriceId });
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  useEffect(() => {
    if (!price) return;
    // The price is now rendered. Retry if authenticated analytics is still initializing.
    let tries = 0;
    let capturedOffer = false;
    let capturedPrice = false;
    const capture = () => {
      tries += 1;
      capturedOffer ||= captureAuthenticatedEvent(
        REGIONAL_SUBSCRIPTION_FIRST_EXPOSURE,
        {
          ...regionalSubscriptionProperties(assignment),
          exposure_surface: "composer",
          subscription_tier: "free",
        },
      );
      capturedPrice ||= captureAuthenticatedEvent(
        PRO_MONTHLY_PRICING_EXPOSURE_EVENT,
        proMonthlyPricingExperimentProperties(price),
      );
      return (capturedOffer && capturedPrice) || tries >= 10;
    };
    if (capture()) return;
    const timer = setInterval(() => {
      if (capture()) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [assignment, price]);

  return (
    <Card
      className="mx-auto my-3 w-full max-w-xl text-left"
      data-testid="regional-subscription-offer"
    >
      <CardHeader>
        <CardTitle className="text-xl">
          Choose a subscription to start
        </CardTitle>
        <CardDescription>
          Ask security questions and run Agent tasks with a paid plan.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div aria-live="polite">
          {price ? (
            <>
              <p className="text-sm font-medium">Pro</p>
              <p>
                <span className="text-3xl font-semibold">
                  ${price.displayedAmountDollars}
                </span>
                <span className="text-sm text-muted-foreground">
                  {" "}
                  USD / month
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Billed monthly. Renews until canceled. Usage limits apply.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {failed
                ? "Pricing is temporarily unavailable. Please try again."
                : "Loading subscription price…"}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {failed ? (
            <Button
              onClick={() => {
                setFailed(false);
                setAttempt((value) => value + 1);
              }}
            >
              Retry pricing
            </Button>
          ) : (
            <Button
              disabled={!price || upgradeLoading}
              onClick={() =>
                void handleUpgrade(
                  "pro-monthly-plan",
                  undefined,
                  undefined,
                  "free",
                  {
                    source: "regional_subscription_first",
                    surface: "composer",
                    reason: "subscription_required",
                    pricing_experiment: price,
                  },
                )
              }
            >
              {upgradeLoading ? "Opening checkout…" : "Subscribe to Pro"}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() =>
              redirectToPricing({
                source: "regional_subscription_first",
                surface: "composer",
                from_tier: "free",
                reason: "subscription_required",
              })
            }
          >
            Compare plans
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Your existing conversations stay available. Subscribe to send a new
          request.
        </p>
      </CardContent>
    </Card>
  );
}

/** Hide only the idle composer; history, billing and in-progress stop controls remain available. */
export function RegionalSubscriptionGate({
  children,
  running,
}: {
  children: ReactNode;
  running: boolean;
}) {
  const { user } = useAuth();
  const { subscription, isCheckingProPlan } = useGlobalState();
  const userId = user?.id;
  const eligible =
    !!userId && subscription === "free" && !isCheckingProPlan && !running;
  const [result, setResult] = useState<{
    userId: string;
    assignment: RegionalSubscriptionAssignment | null;
  }>();
  const capturedControl = useRef<string | null>(null);

  useEffect(() => {
    if (!eligible || !userId) return;
    let active = true;
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      controller?.abort();
      clearTimeout(timeout);
      const request = new AbortController();
      controller = request;
      timeout = setTimeout(() => request.abort(), 5_000);
      void fetch("/api/experiments/regional-subscription-first", {
        cache: "no-store",
        signal: request.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Experiment unavailable");
          const { assignment } = await response.json();
          const valid =
            assignment &&
            (assignment.variant === "test" ||
              assignment.variant === "control") &&
            isSubscriptionFirstCountry(assignment.country);
          if (active && controller === request)
            setResult({ userId, assignment: valid ? assignment : null });
        })
        .catch(() => {
          if (active && controller === request)
            setResult({ userId, assignment: null });
        })
        .finally(() => {
          if (controller === request) clearTimeout(timeout);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      controller?.abort();
      clearTimeout(timeout);
      window.removeEventListener("focus", refresh);
    };
  }, [eligible, userId]);

  const current = eligible && result?.userId === userId ? result : undefined;
  const assignment = current?.assignment;
  useEffect(() => {
    if (assignment?.variant !== "control" || capturedControl.current === userId)
      return;
    let tries = 0;
    const capture = () => {
      tries += 1;
      if (
        captureAuthenticatedEvent(REGIONAL_SUBSCRIPTION_FIRST_EXPOSURE, {
          ...regionalSubscriptionProperties(assignment),
          exposure_surface: "composer",
          subscription_tier: "free",
        })
      ) {
        capturedControl.current = userId ?? null;
        return true;
      }
      return tries >= 10;
    };
    if (capture()) return;
    const timer = setInterval(() => {
      if (capture()) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [assignment, userId]);

  if (!eligible) return children;
  if (!current)
    return (
      <p
        role="status"
        className="p-6 text-center text-sm text-muted-foreground"
      >
        Loading task access…
      </p>
    );
  if (assignment?.variant === "test")
    return <SubscriptionOffer assignment={assignment} />;
  return children;
}
