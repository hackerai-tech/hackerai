import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink, ShieldCheck } from "lucide-react";

import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/public/PublicSiteHeader";
import { JsonLd } from "@/components/seo/JsonLd";
import { Button } from "@/components/ui/button";
import {
  CANCELLATION_HELP_URL,
  EXTRA_USAGE_HELP_URL,
  HELP_CENTER_URL,
  PUBLIC_PAGE_LAST_MODIFIED,
  REFUND_HELP_URL,
  SOFTWARE_APPLICATION_JSON_LD,
  canonicalMetadata,
  formatPublicPageDate,
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

export default function PricingPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <JsonLd data={SOFTWARE_APPLICATION_JSON_LD} />
      <PublicSiteHeader />
      <main>
        <section className="border-b border-border/80">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-18">
            <div className="max-w-3xl">
              <p className="text-sm font-medium text-muted-foreground">
                HackerAI pricing
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Last updated{" "}
                <time dateTime={PUBLIC_PAGE_LAST_MODIFIED.pricing}>
                  {formatPublicPageDate(PUBLIC_PAGE_LAST_MODIFIED.pricing)}
                </time>
              </p>
              <h1 className="mt-3 text-4xl font-semibold leading-tight sm:text-5xl">
                Start locally. Add cloud capacity when you need it.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
                Free includes basic AI access and Agent mode with a local
                sandbox. Paid plans add stronger model access, higher limits,
                files, larger context, and cloud agents.
              </p>
            </div>
          </div>
        </section>

        <section>
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
            <PricingPlans />

            <div className="mt-12 grid gap-8 border-y border-border bg-card/30 py-10 lg:grid-cols-3">
              <div>
                <ShieldCheck className="size-5" aria-hidden="true" />
                <h2 className="mt-4 text-xl font-semibold">
                  Execution boundaries
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Local mode runs commands on your machine without container
                  isolation. Cloud agents use an isolated E2B sandbox and rely
                  on the subprocessors documented by HackerAI.
                </p>
                <Button asChild variant="outline" className="mt-5">
                  <Link href="/trust">Read Security &amp; Trust</Link>
                </Button>
              </div>
              <div>
                <h2 className="text-xl font-semibold">Extra Usage</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Pro, Pro+, and Ultra can optionally continue after included
                  monthly usage runs out. Extra Usage uses a prepaid balance, is
                  charged separately from the subscription, and must be enabled
                  from Settings.
                </p>
                <a
                  href={EXTRA_USAGE_HELP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-2 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  Extra Usage guide
                  <ExternalLink className="size-4" />
                </a>
              </div>
              <div>
                <h2 className="text-xl font-semibold">
                  Cancellation and refunds
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Cancel from Account settings to stop renewal; paid access
                  continues through the current billing period. Refund
                  eligibility depends on location and timing.
                </p>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                  <a
                    href={CANCELLATION_HELP_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Cancellation guide
                    <ExternalLink className="size-4" />
                  </a>
                  <a
                    href={REFUND_HELP_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Refund policy
                    <ExternalLink className="size-4" />
                  </a>
                </div>
                <a
                  href={HELP_CENTER_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  All billing help
                  <ExternalLink className="size-3.5" />
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
