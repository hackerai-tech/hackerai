import type { Metadata } from "next";
import Link from "next/link";
import { CreditCard, ExternalLink, ShieldCheck, Undo2 } from "lucide-react";

import Header from "@/app/components/Header";
import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import { JsonLd } from "@/components/seo/JsonLd";
import { Button } from "@/components/ui/button";
import {
  CANCELLATION_HELP_URL,
  EXTRA_USAGE_HELP_URL,
  HELP_CENTER_URL,
  REFUND_HELP_URL,
  SOFTWARE_APPLICATION_JSON_LD,
  canonicalMetadata,
} from "@/lib/seo/site";
import { PricingPlans } from "./PricingPlans";

const description =
  "Compare current HackerAI Free, Pro, Pro+, Ultra, and Team pricing for AI-assisted penetration testing, local Agent mode, files, and cloud agents.";

export const metadata: Metadata = {
  ...canonicalMetadata("/pricing"),
  title: "Pricing | HackerAI",
  description,
  openGraph: {
    title: "HackerAI Pricing",
    description,
    type: "website",
    url: "/pricing",
  },
  twitter: {
    card: "summary",
    title: "HackerAI Pricing",
    description,
  },
};

export const dynamic = "force-static";

const externalLinkClassName =
  "inline-flex items-center gap-2 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export default function PricingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <JsonLd data={SOFTWARE_APPLICATION_JSON_LD} />
      <Header currentPath="/pricing" />
      <main>
        <section className="border-b border-border/80">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-18">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-sm font-medium text-muted-foreground">Plans</p>
              <h1 className="mt-3 text-5xl font-medium leading-[1.05] tracking-tight sm:text-6xl">
                Pricing
              </h1>
              <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
                Start free with Agent mode on your own machine. Upgrade when you
                need the best models, higher limits, file uploads, a larger
                context window, or cloud agents.
              </p>
            </div>
          </div>
        </section>

        <section>
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
            <PricingPlans />

            <div className="mt-8 grid gap-8 rounded-lg border border-border bg-card/30 p-6 sm:p-8 lg:grid-cols-3">
              <div>
                <ShieldCheck className="size-5" aria-hidden="true" />
                <h2 className="mt-4 text-xl font-semibold">
                  Local or cloud execution
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Local mode runs commands on your machine without container
                  isolation. Cloud agents run in an isolated E2B sandbox and use
                  the subprocessors listed on the Security &amp; Trust page.
                </p>
                <Button asChild variant="outline" className="mt-5">
                  <Link href="/trust">Read Security &amp; Trust</Link>
                </Button>
              </div>
              <div>
                <CreditCard className="size-5" aria-hidden="true" />
                <h2 className="mt-4 text-xl font-semibold">Extra Usage</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Pro, Pro+, and Ultra can keep working after included monthly
                  usage runs out. Extra Usage draws from a prepaid balance, is
                  charged separately from the subscription, and is off until you
                  enable it in Settings.
                </p>
                <a
                  href={EXTRA_USAGE_HELP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={`mt-5 ${externalLinkClassName}`}
                >
                  Extra Usage guide
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </div>
              <div>
                <Undo2 className="size-5" aria-hidden="true" />
                <h2 className="mt-4 text-xl font-semibold">
                  Cancellation and refunds
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Cancel from account settings to stop renewal. Paid access
                  continues until the end of the current billing period. Refund
                  eligibility depends on your location and timing.
                </p>
                <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
                  <a
                    href={CANCELLATION_HELP_URL}
                    target="_blank"
                    rel="noreferrer"
                    className={externalLinkClassName}
                  >
                    Cancellation guide
                    <ExternalLink className="size-4" aria-hidden="true" />
                  </a>
                  <a
                    href={REFUND_HELP_URL}
                    target="_blank"
                    rel="noreferrer"
                    className={externalLinkClassName}
                  >
                    Refund policy
                    <ExternalLink className="size-4" aria-hidden="true" />
                  </a>
                </div>
                <a
                  href={HELP_CENTER_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  All billing help
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>
      <PublicSiteFooter />
    </div>
  );
}
