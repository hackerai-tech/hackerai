import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink, ShieldCheck } from "lucide-react";

import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/public/PublicSiteHeader";
import { JsonLd } from "@/components/seo/JsonLd";
import { Button } from "@/components/ui/button";
import {
  HELP_CENTER_URL,
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

            <div className="mt-12 grid gap-8 bg-card/30 py-10 lg:grid-cols-2">
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
                <h2 className="text-xl font-semibold">Billing questions</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Usage varies by plan and model. Review the in-product usage
                  display for your current allowance, or use the official Help
                  Center for subscription and billing guidance.
                </p>
                <Button asChild variant="outline" className="mt-5">
                  <a href={HELP_CENTER_URL} target="_blank" rel="noreferrer">
                    Help Center
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>
      <PublicSiteFooter />
    </div>
  );
}
