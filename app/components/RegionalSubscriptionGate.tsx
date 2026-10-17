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
import {
  REGIONAL_PAYWALL_KEY,
  type RegionalPaywallVariant,
} from "@/lib/experiments/regional-paywall";
import {
  ArrowRight,
  Check,
  ChevronDown,
  FileSearch,
  Terminal,
} from "lucide-react";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  REGIONAL_SUBSCRIPTION_FIRST_EXPOSURE,
  isSubscriptionFirstCountry,
  regionalSubscriptionProperties,
  type RegionalSubscriptionAssignment,
} from "@/lib/experiments/regional-subscription-first";
import {
  PRO_MONTHLY_PRICE_LOOKUP_KEY,
  type ProMonthlyPricePresentation,
} from "@/lib/pricing/pro-monthly";
import { PRICING } from "@/lib/pricing/config";

function SubscriptionOffer({
  assignment,
  paywallVariant,
}: {
  assignment: RegionalSubscriptionAssignment;
  paywallVariant: RegionalPaywallVariant | null;
}) {
  const { handleUpgrade, upgradeLoading } = useUpgrade();
  const paywallVersion = paywallVariant === "test" ? 2 : 1;
  const [price, setPrice] = useState<ProMonthlyPricePresentation>();
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
        if (
          value.priceLookupKey !== PRO_MONTHLY_PRICE_LOOKUP_KEY ||
          value.displayedAmountDollars !== PRICING.pro.monthly ||
          value.currency !== "usd" ||
          value.billingInterval !== "month" ||
          typeof value.stripePriceId !== "string" ||
          !value.stripePriceId
        )
          throw new Error("Invalid price");
        if (active)
          setPrice({
            priceLookupKey: PRO_MONTHLY_PRICE_LOOKUP_KEY,
            displayedAmountDollars: PRICING.pro.monthly,
            currency: "usd",
            billingInterval: "month",
            stripePriceId: value.stripePriceId,
          });
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
    const capture = () => {
      tries += 1;
      capturedOffer ||= captureAuthenticatedEvent(
        REGIONAL_SUBSCRIPTION_FIRST_EXPOSURE,
        {
          ...regionalSubscriptionProperties(assignment),
          exposure_surface: "composer",
          subscription_tier: "free",
          paywall_version: paywallVersion,
          ...(paywallVariant && {
            [`$feature/${REGIONAL_PAYWALL_KEY}`]: paywallVariant,
          }),
          displayed_amount_dollars: price.displayedAmountDollars,
        },
      );
      return capturedOffer || tries >= 10;
    };
    if (capture()) return;
    const timer = setInterval(() => {
      if (capture()) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [assignment, price, paywallVariant, paywallVersion]);

  const captureAction = (
    action: "checkout" | "compare_plans" | "view_example",
  ) => {
    captureAuthenticatedEvent("regional_subscription_paywall_action", {
      ...regionalSubscriptionProperties(assignment),
      displayed_amount_dollars: price?.displayedAmountDollars,
      paywall_version: paywallVersion,
      ...(paywallVariant && {
        [`$feature/${REGIONAL_PAYWALL_KEY}`]: paywallVariant,
      }),
      exposure_surface: "composer",
      action,
    });
  };

  if (paywallVariant !== "test")
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
                onClick={() => {
                  captureAction("checkout");
                  void handleUpgrade(
                    "pro-monthly-plan",
                    undefined,
                    undefined,
                    "free",
                    {
                      source: "regional_subscription_first",
                      surface: "composer",
                      reason: "subscription_required",
                    },
                  );
                }}
              >
                {upgradeLoading ? "Opening checkout…" : "Subscribe to Pro"}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={upgradeLoading}
              onClick={() => {
                captureAction("compare_plans");
                redirectToPricing({
                  source: "regional_subscription_first",
                  surface: "composer",
                  from_tier: "free",
                  reason: "subscription_required",
                });
              }}
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

  return (
    <Card
      className="@container mx-auto my-3 max-h-[80svh] w-full max-w-2xl gap-0 overflow-y-auto p-0 text-left"
      data-testid="regional-subscription-offer"
    >
      <div className="space-y-2 p-4 @min-[34rem]:space-y-3 @min-[34rem]:p-6 @min-[34rem]:pb-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          HackerAI Pro
        </p>
        <h2 className="text-xl font-semibold leading-tight tracking-tight @min-[34rem]:text-2xl">
          Start your next security task
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Review code, investigate vulnerabilities, and run tools with AI.
        </p>
        <p className="text-xs text-muted-foreground">
          A paid plan is required to send requests from your region.
        </p>
      </div>

      <div className="grid border-t @min-[34rem]:grid-cols-[1fr_15rem]">
        <div className="flex flex-col gap-3 @min-[34rem]:gap-4 @min-[34rem]:col-start-2 @min-[34rem]:row-start-1 bg-muted/30 p-4 @min-[34rem]:border-l @min-[34rem]:border-t-0 @min-[34rem]:p-6">
          <div aria-live="polite" aria-atomic="true">
            <p className="mb-2 text-sm font-medium">Start with Pro</p>
            {price ? (
              <>
                <p>
                  <span className="text-4xl font-semibold tracking-tight">
                    ${price.displayedAmountDollars}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {" "}
                    / month
                  </span>
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  USD, billed monthly. Renews until canceled. Usage limits
                  apply.
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
          <div className="space-y-2">
            {failed ? (
              <Button
                className="h-11 w-full"
                onClick={() => {
                  setFailed(false);
                  setAttempt((value) => value + 1);
                }}
              >
                Retry pricing
              </Button>
            ) : (
              <Button
                className="h-11 w-full"
                disabled={!price || upgradeLoading}
                onClick={() => {
                  captureAction("checkout");
                  void handleUpgrade(
                    "pro-monthly-plan",
                    undefined,
                    undefined,
                    "free",
                    {
                      source: "regional_subscription_first",
                      surface: "composer",
                      reason: "subscription_required",
                    },
                  );
                }}
              >
                {upgradeLoading ? "Opening checkout…" : "Get Pro"}
                {!upgradeLoading && (
                  <ArrowRight aria-hidden="true" className="size-4" />
                )}
              </Button>
            )}
            <Button
              className="h-11 w-full"
              variant="ghost"
              disabled={upgradeLoading}
              onClick={() => {
                captureAction("compare_plans");
                redirectToPricing({
                  source: "regional_subscription_first",
                  surface: "composer",
                  from_tier: "free",
                  reason: "subscription_required",
                });
              }}
            >
              Compare plans
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Cancel renewal anytime in billing settings. Your existing
            conversations stay available.
          </p>
        </div>
        <div className="space-y-4 border-t p-5 @min-[34rem]:col-start-1 @min-[34rem]:row-start-1 @min-[34rem]:border-t-0 @min-[34rem]:p-6">
          <ul className="space-y-3 text-sm">
            <li className="flex gap-3">
              <Terminal
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <div>
                <p className="font-medium">Run tools with cloud Agent</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Start without setting up a local sandbox.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <FileSearch
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <div>
                <p className="font-medium">Bring your code and files</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Upload context to investigate issues and plan fixes.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <Check
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <div>
                <p className="font-medium">Go deeper with Pro models</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Higher usage limits and more room for context.
                </p>
              </div>
            </li>
          </ul>
          <details
            className="group rounded-lg border bg-muted/30 text-sm"
            onToggle={(event) => {
              if (event.currentTarget.open) captureAction("view_example");
            }}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              See an example workflow
              <ChevronDown
                aria-hidden="true"
                className="size-4 shrink-0 transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="space-y-3 border-t p-3 text-xs leading-relaxed">
              <p className="text-muted-foreground">
                Illustrative example. No task is running.
              </p>
              <p className="rounded-md bg-background p-3 font-medium">
                “Review my API code for access-control issues.”
              </p>
              <ol className="list-decimal space-y-2 pl-4 text-muted-foreground">
                <li>
                  Upload the relevant code and describe your authorized scope.
                </li>
                <li>
                  Ask Agent to trace authorization checks and investigate
                  potential gaps.
                </li>
                <li>
                  Review the evidence, suggested fixes, and follow-up tests.
                </li>
              </ol>
              <p className="text-muted-foreground">
                Results depend on your task. Validate findings before acting on
                them.
              </p>
            </div>
          </details>
        </div>
      </div>
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
    paywallVariant: RegionalPaywallVariant | null;
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
          const { assignment, paywallVariant } = await response.json();
          const valid =
            assignment &&
            (assignment.variant === "test" ||
              assignment.variant === "control") &&
            isSubscriptionFirstCountry(assignment.country);
          if (active && controller === request)
            setResult({
              userId,
              assignment: valid ? assignment : null,
              paywallVariant:
                paywallVariant === "test" || paywallVariant === "control"
                  ? paywallVariant
                  : null,
            });
        })
        .catch(() => {
          if (active && controller === request)
            setResult({ userId, assignment: null, paywallVariant: null });
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
    return (
      <SubscriptionOffer
        key={userId}
        assignment={assignment}
        paywallVariant={current.paywallVariant}
      />
    );
  return children;
}
