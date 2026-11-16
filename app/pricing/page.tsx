import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";

import Header from "@/app/components/Header";
import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import { JsonLd } from "@/components/seo/JsonLd";
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
      <Header currentPath="/pricing" publicRedesign />
      <main>
        <section>
          <div className="mx-auto grid max-w-[1280px] gap-8 px-4 pb-12 pt-20 sm:px-6 md:pt-24 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] lg:items-end lg:gap-14 lg:px-10">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
                Pricing
              </p>
              <h1 className="mt-6 max-w-[760px] text-[clamp(2.7rem,5vw,4.7rem)] font-semibold leading-[1.05] tracking-[-0.055em]">
                Choose the plan that fits your work.
              </h1>
            </div>
            <p className="max-w-[460px] text-base leading-7 text-muted-foreground">
              Compare models, usage, and local or cloud Agent access. Free
              access has limited usage and may be unavailable in some locations.
            </p>
          </div>
        </section>

        <section>
          <div className="mx-auto max-w-[1280px] px-4 pb-20 sm:px-6 lg:px-10">
            <PricingPlans />

            <div className="mt-20 grid border-t border-border md:grid-cols-3">
              <div className="border-b border-border py-8 md:border-b-0 md:pr-8">
                <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  Execution
                </p>
                <h2 className="mt-3 text-xl font-semibold">
                  Local or cloud execution
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Local mode runs commands on your own machine. Cloud agents run
                  in an isolated sandbox we host. Both are spelled out on the
                  Security &amp; Trust page.
                </p>
                <Link href="/trust" className={`mt-5 ${externalLinkClassName}`}>
                  Read Security &amp; Trust →
                </Link>
              </div>
              <div className="border-b border-border py-8 md:border-b-0 md:border-l md:px-8">
                <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  Extra Usage
                </p>
                <h2 className="mt-3 text-xl font-semibold">
                  Keep working past included usage
                </h2>
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
              <div className="py-8 md:border-l md:pl-8">
                <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  Billing
                </p>
                <h2 className="mt-3 text-xl font-semibold">
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
      <PublicSiteFooter redesign />
    </div>
  );
}
