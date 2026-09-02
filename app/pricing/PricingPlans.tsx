"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

import BillingFrequencySelector from "@/app/components/BillingFrequencySelector";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PLAN_HEADERS,
  PRICING,
  freeFeatures,
  proFeatures,
  proPlusFeatures,
  teamFeatures,
  ultraFeatures,
} from "@/lib/pricing/features";

type BillingFrequency = "monthly" | "yearly";

const plans = [
  {
    key: "free",
    name: "Free",
    description: "Try HackerAI",
    features: freeFeatures,
    featureHeader: PLAN_HEADERS.free,
  },
  {
    key: "pro",
    name: "Pro",
    description: "For regular security work",
    features: proFeatures,
    featureHeader: PLAN_HEADERS.pro,
  },
  {
    key: "pro-plus",
    name: "Pro+",
    description: "For higher-volume workflows",
    features: proPlusFeatures,
    featureHeader: PLAN_HEADERS["pro-plus"],
  },
  {
    key: "ultra",
    name: "Ultra",
    description: "For intensive daily use",
    features: ultraFeatures,
    featureHeader: PLAN_HEADERS.ultra,
  },
] as const;

/** Mirrors the plan highlighted in the in-app pricing dialog. */
const RECOMMENDED_PLAN = "pro-plus";

function billingNote(frequency: BillingFrequency) {
  return frequency === "yearly" ? "Per month, billed yearly" : "Billed monthly";
}

export function PricingPlans() {
  const [frequency, setFrequency] = useState<BillingFrequency>("monthly");

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Individual plans</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Prices in USD. Change or cancel your plan any time from account
            settings.
          </p>
        </div>
        <BillingFrequencySelector value={frequency} onChange={setFrequency} />
      </div>

      <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => {
          const price = plan.key === "free" ? 0 : PRICING[plan.key][frequency];
          const recommended = plan.key === RECOMMENDED_PLAN;

          return (
            <article
              key={plan.key}
              aria-label={`${plan.name} plan`}
              className={cn(
                "flex flex-col bg-background p-6",
                recommended && "ring-1 ring-inset ring-foreground/30",
              )}
            >
              <div className="flex h-6 items-center justify-between gap-2">
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                {recommended ? (
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground">
                    Recommended
                  </span>
                ) : null}
              </div>
              <p className="mt-2 min-h-10 text-sm leading-5 text-muted-foreground">
                {plan.description}
              </p>
              <div className="mt-5 flex h-12 items-end gap-1">
                <span className="text-4xl font-semibold">${price}</span>
                <span className="pb-1 text-sm text-muted-foreground">
                  / month
                </span>
              </div>
              <p className="mt-2 min-h-5 text-xs leading-5 text-muted-foreground">
                {plan.key === "free"
                  ? "No payment method required"
                  : billingNote(frequency)}
              </p>
              <Button
                asChild
                className="mt-5 w-full"
                variant={recommended ? "default" : "outline"}
              >
                <Link href="/signup">
                  {plan.key === "free" ? "Start free" : `Choose ${plan.name}`}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              {plan.featureHeader ? (
                <p className="mt-6 text-sm font-medium">{plan.featureHeader}</p>
              ) : null}
              <ul
                className={cn(
                  "space-y-3 text-sm",
                  plan.featureHeader ? "mt-3" : "mt-6",
                )}
              >
                {plan.features.map((feature) => (
                  <li key={feature.text} className="flex items-start gap-2.5">
                    <Check
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground">
                      {feature.text}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>

      <section
        aria-label="Team plan"
        className="mt-8 grid gap-6 rounded-lg border border-border p-6 sm:p-8 lg:grid-cols-[1fr_auto] lg:items-center"
      >
        <div>
          <h2 className="text-2xl font-semibold">Team</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Everything in Pro for every seat, plus shared billing and seat
            management for a group of practitioners.
          </p>
          <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {teamFeatures.map((feature) => (
              <li key={feature.text} className="flex items-center gap-2">
                <Check className="size-4" aria-hidden="true" />
                {feature.text}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-5 lg:justify-end">
          <div>
            <span className="text-3xl font-semibold">
              ${PRICING.team[frequency]}
            </span>
            <span className="text-sm text-muted-foreground">
              {" "}
              / seat / month
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              {billingNote(frequency)}
            </p>
          </div>
          <Button asChild>
            <Link href="/signup">
              Choose Team
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </section>
    </>
  );
}
