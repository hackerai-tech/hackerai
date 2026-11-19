"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

import BillingFrequencySelector from "@/app/components/BillingFrequencySelector";
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
type PaidPlanKey = keyof typeof PRICING;

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

const RECOMMENDED_PLAN = "pro-plus";

function billingDetail(plan: PaidPlanKey, frequency: BillingFrequency) {
  return frequency === "yearly"
    ? `$${PRICING[plan].yearly * 12} billed yearly · $${PRICING[plan].monthly}/month if billed monthly`
    : `Billed monthly · $${PRICING[plan].yearly}/month if billed yearly`;
}

const ctaClassName =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function PricingPlans() {
  const [frequency, setFrequency] = useState<BillingFrequency>("monthly");

  return (
    <>
      <div className="flex flex-col gap-6 border-t border-border pt-8 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Individual plans
          </h2>
          <p className="mt-2 max-w-[640px] text-sm leading-6 text-muted-foreground">
            Paid plans&apos; included usage refills every month, whether you pay
            monthly or yearly. Change or cancel your plan any time from account
            settings.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <BillingFrequencySelector value={frequency} onChange={setFrequency} />
          <p className="text-xs text-muted-foreground">All prices in USD</p>
        </div>
      </div>

      <div className="mt-7 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => {
          const recommended = plan.key === RECOMMENDED_PLAN;
          const price = plan.key === "free" ? 0 : PRICING[plan.key][frequency];

          return (
            <article
              key={plan.key}
              aria-label={`${plan.name} plan`}
              className={cn(
                "relative flex flex-col bg-background p-5 sm:p-6",
                recommended && "bg-[#1a1a1a] ring-1 ring-inset ring-[#b9b7ff]",
              )}
            >
              <div className="sm:flex sm:items-start sm:justify-between sm:gap-4 md:block">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold">{plan.name}</h3>
                    {recommended ? (
                      <span className="font-mono text-[10px] font-medium uppercase tracking-widest text-[#b9b7ff] md:hidden xl:inline">
                        Recommended
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    {plan.description}
                  </p>
                </div>
                <div className="mt-4 sm:mt-0 sm:shrink-0 sm:text-right md:mt-8 md:text-left">
                  <div className="flex items-baseline gap-1 sm:justify-end md:justify-start">
                    <span className="text-4xl font-semibold tracking-tight">
                      ${price}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      /month
                    </span>
                  </div>
                  <p className="mt-1 max-w-[230px] text-xs leading-5 text-muted-foreground">
                    {plan.key === "free"
                      ? "Free usage and availability vary by location."
                      : billingDetail(plan.key, frequency)}
                  </p>
                </div>
              </div>

              <Link
                href="/signup"
                className={cn(
                  ctaClassName,
                  "order-3 mt-5 w-full sm:order-2",
                  recommended
                    ? "border-white bg-white text-black hover:bg-white/90"
                    : "border-border text-foreground hover:bg-accent",
                )}
              >
                {plan.key === "free" ? "Create account" : `Choose ${plan.name}`}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>

              <div className="order-2 mt-5 flex-1 sm:order-3 sm:mt-7">
                {plan.featureHeader ? (
                  <p className="text-sm font-medium">{plan.featureHeader}</p>
                ) : null}
                <ul
                  className={cn(
                    "space-y-3 text-sm",
                    plan.featureHeader && "mt-3",
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
              </div>
            </article>
          );
        })}
      </div>

      <section
        aria-label="Team plan"
        className="mt-7 rounded-2xl border border-border p-6 sm:p-8"
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
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
          <div className="flex flex-wrap items-center gap-6 lg:justify-end">
            <div>
              <span className="text-3xl font-semibold">
                ${PRICING.team[frequency]}
              </span>
              <span className="text-sm text-muted-foreground">
                {" "}
                /seat/month
              </span>
              <p className="mt-1 max-w-[240px] text-xs leading-5 text-muted-foreground">
                {billingDetail("team", frequency)}
              </p>
            </div>
            <Link
              href="/signup"
              className={cn(
                ctaClassName,
                "border-border text-foreground hover:bg-accent",
              )}
            >
              Choose Team <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
