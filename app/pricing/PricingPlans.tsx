"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

import BillingFrequencySelector from "@/app/components/BillingFrequencySelector";
import { Button } from "@/components/ui/button";
import {
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
    description: "Explore HackerAI",
    features: freeFeatures,
  },
  {
    key: "pro",
    name: "Pro",
    description: "For regular security work",
    features: proFeatures,
  },
  {
    key: "pro-plus",
    name: "Pro+",
    description: "For higher-volume workflows",
    features: [...proFeatures, ...proPlusFeatures],
  },
  {
    key: "ultra",
    name: "Ultra",
    description: "For intensive daily use",
    features: [...proFeatures, ...ultraFeatures],
  },
] as const;

export function PricingPlans() {
  const [frequency, setFrequency] = useState<BillingFrequency>("monthly");

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Individual plans</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Prices are in USD. Change or cancel your plan from account settings.
          </p>
        </div>
        <BillingFrequencySelector value={frequency} onChange={setFrequency} />
      </div>

      <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => {
          const price = plan.key === "free" ? 0 : PRICING[plan.key][frequency];
          const featured = plan.key === "pro";

          return (
            <article
              key={plan.key}
              className={`flex min-h-[430px] flex-col bg-background p-6 ${
                featured ? "ring-1 ring-inset ring-foreground/30" : ""
              }`}
            >
              <div className="flex h-6 items-center justify-between gap-2">
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                {featured ? (
                  <span className="text-xs font-medium text-muted-foreground">
                    Most popular
                  </span>
                ) : null}
              </div>
              <p className="mt-2 h-10 text-sm leading-5 text-muted-foreground">
                {plan.description}
              </p>
              <div className="mt-5 flex h-12 items-end gap-1">
                <span className="text-4xl font-semibold">${price}</span>
                <span className="pb-1 text-sm text-muted-foreground">
                  {plan.key === "free" ? "forever" : "/ month"}
                </span>
              </div>
              <p className="mt-2 h-10 text-xs leading-5 text-muted-foreground">
                {plan.key === "free"
                  ? "No payment method required"
                  : frequency === "yearly"
                    ? "Monthly equivalent, billed annually"
                    : "Billed monthly"}
              </p>
              <Button
                asChild
                className="mt-5 w-full"
                variant={featured ? "default" : "outline"}
              >
                <Link href="/signup">
                  {plan.key === "free" ? "Start free" : `Choose ${plan.name}`}
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <ul className="mt-6 space-y-3 text-sm">
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

      <section className="mt-10 grid gap-7 border-y border-border py-9 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <h2 className="text-2xl font-semibold">Team</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Shared billing and seat management with 2x more usage than Pro for
            each seat. HackerAI remains optimized for hands-on practitioners.
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
        <div className="flex items-center gap-5 lg:justify-end">
          <div>
            <span className="text-3xl font-semibold">
              ${PRICING.team[frequency]}
            </span>
            <span className="text-sm text-muted-foreground">
              {" "}
              / seat / month
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              {frequency === "yearly" ? "Billed annually" : "Billed monthly"}
            </p>
          </div>
          <Button asChild>
            <Link href="/signup">Choose Team</Link>
          </Button>
        </div>
      </section>
    </>
  );
}
