import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Check } from "lucide-react";
import Header from "@/app/components/Header";
import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import { abuseIntakeEnabled } from "@/lib/abuse/evidence";
import { abuseTurnstileConfig } from "@/lib/abuse/turnstile";
import { ABUSE_EMAIL } from "@/lib/abuse/report";
import { canonicalMetadata, HELP_CENTER_URL } from "@/lib/seo/site";
import ReportForm from "./ReportForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  ...canonicalMetadata("/abuse"),
  title: "Report abuse | HackerAI",
  description:
    "Report suspected misuse of HackerAI or ask for a review of an account restriction. No HackerAI account required.",
};

function ReportingRoutes() {
  return (
    <section aria-label="Choose the right reporting path">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        Is this the right place?
      </h2>
      <div className="space-y-0 divide-y divide-border border-y border-border">
        <div className="flex gap-3 py-4">
          <Check className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <p className="text-sm leading-6">
            <strong className="font-medium">
              You suspect someone misused HackerAI
            </strong>
            <span className="block text-muted-foreground">
              Use this form. You do not need to own the affected system.
            </span>
          </p>
        </div>
        <div className="flex gap-3 py-4">
          <ArrowUpRight className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <p className="text-sm leading-6">
            <strong className="font-medium">
              You found a vulnerability in HackerAI
            </strong>
            <span className="block text-muted-foreground">
              See{" "}
              <Link
                href="/trust#responsible-disclosure"
                className="text-foreground underline underline-offset-4"
              >
                responsible disclosure
              </Link>
              .
            </span>
          </p>
        </div>
        <div className="flex gap-3 py-4">
          <ArrowUpRight className="mt-1 size-4 shrink-0" aria-hidden="true" />
          <p className="text-sm leading-6">
            <strong className="font-medium">
              You need help with your account or billing
            </strong>
            <span className="block text-muted-foreground">
              Visit the{" "}
              <a
                href={HELP_CENTER_URL}
                className="text-foreground underline underline-offset-4"
              >
                Help Center
              </a>
              .
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}

export default function AbusePage() {
  const turnstile = abuseTurnstileConfig();
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <Header currentPath="/trust" />
      <main
        id="main-content"
        className="mx-auto max-w-6xl px-4 py-10 max-[359px]:px-2.5 sm:px-6 sm:py-20"
      >
        <header className="mb-10 max-w-3xl sm:mb-14">
          <p className="mb-6 text-sm text-muted-foreground">
            <Link
              href="/trust"
              className="rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Security &amp; Trust
            </Link>{" "}
            / Abuse reports
          </p>
          <h1 className="text-[40px] font-medium leading-[1.1] tracking-tight sm:text-[56px]">
            Report abuse
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
            Tell us about suspected misuse of HackerAI, or ask us to review a
            decision we made. You do not need an account. Reports are reviewed
            before any account action.
          </p>
        </header>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)] lg:gap-16">
          <div className="lg:hidden">
            <ReportingRoutes />
          </div>
          <ReportForm
            available={abuseIntakeEnabled() && Boolean(turnstile)}
            siteKey={turnstile?.siteKey}
          />
          <aside className="space-y-10">
            <div className="hidden lg:block">
              <ReportingRoutes />
            </div>
            <section>
              <h2 className="mb-4 text-sm font-medium text-muted-foreground">
                What happens next
              </h2>
              <ol className="list-decimal space-y-4 pl-5 text-sm leading-6 marker:text-muted-foreground">
                <li>
                  We queue your report for email delivery and show a report
                  reference.
                </li>
                <li>
                  A report on its own does not suspend an account. Any action
                  requires review.
                </li>
                <li>
                  We may contact you at the email you provided if more
                  information is needed.
                </li>
              </ol>
            </section>
            <section>
              <h2 className="mb-4 text-sm font-medium text-muted-foreground">
                Keep evidence minimal
              </h2>
              <p className="text-sm leading-6">
                Share only what shows the activity. Please leave out:
              </p>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
                <li>Passwords, API keys, or session tokens</li>
                <li>Personal data we do not need to review the report</li>
                <li>Illegal material of any kind</li>
              </ul>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                Links are not automatically fetched when you submit.
              </p>
            </section>
            <section className="border-t border-border pt-6">
              <h2 className="mb-4 text-sm font-medium text-muted-foreground">
                Appealing a decision
              </h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Choose “Appeal a decision” and include any case reference or
                notice you received. Explain why the decision should change and
                how we can reach you. Submitting an appeal does not
                automatically lift a restriction.
              </p>
            </section>
            {process.env.ABUSE_EMAIL_VERIFIED === "true" && (
              <section className="border-t border-border pt-6">
                <h2 className="mb-3 text-sm font-medium">Prefer email?</h2>
                <a
                  href={`mailto:${ABUSE_EMAIL}`}
                  className="break-all text-sm underline underline-offset-4"
                >
                  {ABUSE_EMAIL}
                </a>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Include the same incident details and only minimal, redacted
                  evidence.
                </p>
              </section>
            )}
          </aside>
        </div>
      </main>
      <PublicSiteFooter />
    </div>
  );
}
