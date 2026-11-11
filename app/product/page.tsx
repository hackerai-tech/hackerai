import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";

import Header from "@/app/components/Header";
import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import { ZoomableImage } from "@/components/public/ZoomableImage";
import { JsonLd } from "@/components/seo/JsonLd";
import { Button } from "@/components/ui/button";
import {
  GITHUB_URL,
  HELP_CENTER_URL,
  LOCAL_AGENT_HELP_URL,
  SOFTWARE_APPLICATION_JSON_LD,
  STATUS_PAGE_URL,
  canonicalMetadata,
} from "@/lib/seo/site";

const description =
  "See how HackerAI combines security-focused AI, Agent mode, terminal and browser tools, files, and local or cloud execution for penetration testing.";

const AGENT_SCREENSHOT_ALT =
  "HackerAI Agent task “Hacking OWASP Juice Shop” in a cloud sandbox with Full access, working on the prompt “Perform reconnaissance and hack OWASP Juice Shop at http://localhost:3000”. Expanded reasoning notes SQL injection and null-byte results while the Agent inspects user records, writes sqli_dump.sh, and generates its next command.";

const socialImage = {
  url: "/images/hackerai-product-agent.png",
  width: 3840,
  height: 2160,
  alt: AGENT_SCREENSHOT_ALT,
};

export const metadata: Metadata = {
  ...canonicalMetadata("/product"),
  title: "Product | HackerAI",
  description,
  openGraph: {
    title: "HackerAI Product",
    description,
    type: "website",
    url: "/product",
    images: [socialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: "HackerAI Product",
    description,
    images: [socialImage],
  },
};

export const dynamic = "force-static";

const heroNotes = [
  {
    title: "Your prompt",
    copy: "Perform reconnaissance and hack OWASP Juice Shop at http://localhost:3000",
  },
  {
    title: "The exploit, live",
    copy: "The Agent runs a SQL injection login bypass proof of concept while the task is active.",
  },
  {
    title: "Proof follows",
    copy: "Confirmed vulnerabilities stay linked to the evidence gathered in the run.",
  },
] as const;

const steps = [
  {
    label: "Point it at a target",
    title: "Point it at a target. It does the work.",
    copy: "Ask for focused analysis, or switch to Agent and it plans and runs multi-step work with the tools it needs. The more context you give it, the further it gets.",
  },
  {
    label: "Real tools, raw output",
    title: "Real tools. Raw output.",
    copy: "A terminal and a browser are in the loop. It runs the commands, opens the pages, and shows you the output as it came back, not a summary of it.",
  },
  {
    label: "Your context, its starting point",
    title: "Your context. Its starting point.",
    copy: "Drop in reports, screenshots, source, and data. HackerAI works from what you give it instead of guessing at your environment.",
  },
  {
    label: "Every finding, traced end to end",
    title: "Every finding, traced end to end.",
    copy: "Commands, output, notes, and findings stay attached to the task. Every claim in your write-up points back to what actually ran.",
  },
] as const;

const comparisonRows = [
  {
    label: "How it connects",
    local:
      "HackerAI Desktop or the Local Agent CLI connects Agent mode to your own toolchain.",
    cloud: "Start in the browser. Nothing to install.",
  },
  {
    label: "Where commands run",
    local: "On your machine, with your user’s privileges.",
    cloud: "Terminal and browser actions run in an isolated sandbox we host.",
  },
  {
    label: "Isolation",
    local:
      "No container isolation. Use local mode on a dedicated testing box you control.",
    cloud: "Isolated sandbox. Delete it whenever you like from Settings.",
    localEmphasis: true,
  },
] as const;

const permissionLevels = [
  {
    label: "Ask for approval",
    copy: "Always ask before commands and file changes.",
  },
  {
    label: "Approve for me",
    copy: "Only ask for actions detected as potentially unsafe. Where available.",
  },
  {
    label: "Full access",
    copy: "Run commands and edit files without asking.",
  },
] as const;

const expectations = [
  {
    title: "You validate. It assists.",
    copy: "AI output and tool actions can be incomplete or wrong. Confirm evidence and impact before you report or act on it.",
  },
  {
    title: "Nothing local until you say so.",
    copy: "Commands only run on your machine after you connect HackerAI Desktop or the Local Agent CLI.",
  },
  {
    title: "Plans set the limits.",
    copy: "Model access, included usage, files, context, and cloud-agent capacity depend on your plan and current availability.",
  },
] as const;

const officialLinks = [
  { href: GITHUB_URL, label: "Source code" },
  { href: HELP_CENTER_URL, label: "Help Center" },
  { href: STATUS_PAGE_URL, label: "Status page" },
] as const;

const container = "mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-10";
const sectionClassName = "border-b border-border/80";
const sectionPadding = "py-20 md:py-24 lg:py-32";
const eyebrow =
  "font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground";
const sectionTitle =
  "text-[clamp(2.1rem,4vw,2.75rem)] font-semibold leading-[1.08] tracking-[-0.045em] text-balance";
const lead = "text-base leading-7 text-muted-foreground";
const mono = "font-mono text-xs text-muted-foreground";
const inlineLink =
  "inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

function SectionIntro({
  id,
  label,
  title,
  children,
}: {
  id: string;
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)] lg:items-end lg:gap-14">
      <div>
        <p className={eyebrow}>{label}</p>
        <h2 id={id} className={`mt-5 max-w-[640px] ${sectionTitle}`}>
          {title}
        </h2>
      </div>
      <p className={`max-w-[460px] ${lead}`}>{children}</p>
    </div>
  );
}

function PrimaryActions({ hidePricingOnMobile = false }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
      <Button asChild size="lg" className="h-12 w-full sm:h-10 sm:w-auto">
        <Link href="/signup">
          Start free
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </Button>
      <Button
        asChild
        size="lg"
        variant="outline"
        className={`h-12 w-full sm:h-10 sm:w-auto ${hidePricingOnMobile ? "max-sm:hidden" : ""}`}
      >
        <Link href="/pricing">View pricing</Link>
      </Button>
    </div>
  );
}

export default function ProductPage() {
  const featuredStep = steps.length - 1;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <JsonLd data={SOFTWARE_APPLICATION_JSON_LD} />
      <Header currentPath="/product" publicRedesign />
      <main>
        {/* Hero */}
        <section className={sectionClassName}>
          <div
            className={`${container} pt-10 pb-20 sm:pt-16 md:pb-24 lg:pt-24`}
          >
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-end lg:gap-14">
              <div>
                <p className={eyebrow}>Product</p>
                <h1 className="mt-4 text-[clamp(2.3rem,6.5vw,4.7rem)] font-semibold leading-[1.05] tracking-[-0.055em] sm:mt-6 lg:max-w-[760px]">
                  The AI agent for penetration testing.
                </h1>
              </div>
              <div>
                <p className={`max-w-[560px] sm:text-lg lg:text-base ${lead}`}>
                  Point it at a target. It runs the recon, the tools, and keeps
                  the evidence. On your machine or in an isolated cloud sandbox.
                </p>
                <div className="mt-7">
                  <PrimaryActions />
                </div>
              </div>
            </div>

            {/* Desktop and half-screen: the complete live Agent capture. */}
            <div className="mt-14 hidden md:block lg:mt-16">
              <ZoomableImage
                src="/images/hackerai-product-agent.png"
                alt={AGENT_SCREENSHOT_ALT}
                width={3840}
                height={2160}
                priority
                frameClassName="aspect-video rounded-xl border border-border bg-card shadow-2xl shadow-black/40"
              />
              <ol className="mt-8 grid grid-cols-3 gap-8">
                {heroNotes.map((note, index) => (
                  <li key={note.title}>
                    <span
                      className={`flex items-center gap-2 ${mono}`}
                      aria-hidden="true"
                    >
                      <span className="h-px w-6 bg-border" />
                      <span className="size-1.5 rounded-full bg-foreground" />
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <p className="mt-3 text-sm font-medium">{note.title}</p>
                    <p className="mt-1.5 max-w-[340px] text-sm leading-6 text-muted-foreground">
                      {note.copy}
                    </p>
                  </li>
                ))}
              </ol>
            </div>

            {/* Mobile: the saved finding reads at phone width. */}
            <figure className="mt-10 md:hidden">
              <ZoomableImage
                src="/images/hackerai-product-finding-mobile.jpg"
                alt="HackerAI finding report on a phone: Authentication bypass via SQL injection in POST /rest/user/login (OWASP Juice Shop v20.4.0), High severity, CVSS 3.1 8.2, runtime reproduced"
                width={390}
                height={844}
                frameClassName="aspect-[390/540] rounded-xl border border-border bg-card"
              />
              <figcaption className="mt-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  Confirmed finding:
                </span>{" "}
                High, CVSS 8.2, saved as a report.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* 01 · How it works */}
        <section className={sectionClassName} aria-labelledby="how-it-works">
          <div className={`${container} ${sectionPadding}`}>
            <SectionIntro
              id="how-it-works"
              label="01 · How it works"
              title="Findings are cheap. Proof is the job."
            >
              Scanners produce lists. Pentesters, bug bounty hunters, and red
              teams need reproducible evidence and a write-up that holds up.
              HackerAI keeps the whole engagement in one task, from first scan
              to final report.
            </SectionIntro>

            {/* Desktop and half-screen: numbered labels with the featured proof. */}
            <ol className="mt-14 hidden grid-cols-4 gap-6 md:grid lg:mt-16">
              {steps.map((step, index) => (
                <li
                  key={step.label}
                  className={`border-t pt-4 ${index === featuredStep ? "border-foreground" : "border-border"}`}
                >
                  <span className={mono}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <p
                    className={`mt-2 text-sm ${index === featuredStep ? "font-medium text-foreground" : "text-muted-foreground"}`}
                  >
                    {step.label}
                  </p>
                </li>
              ))}
            </ol>
            <div className="mt-12 hidden gap-8 md:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.85fr)] lg:items-start lg:gap-16">
              <div className="lg:pt-4">
                <h3 className="text-2xl font-semibold tracking-[-0.03em]">
                  Every finding, traced end to end.
                </h3>
                <p className="mt-4 max-w-[480px] text-sm leading-6 text-muted-foreground">
                  When the agent confirms an issue, it saves a report with
                  severity, evidence, reproduction steps and a suggested fix.
                  Open it from Findings, or jump back to the message that
                  produced it.
                </p>
                <p className={`mt-6 uppercase tracking-[0.12em] ${mono}`}>
                  From an earlier run on the same lab
                </p>
              </div>
              {/* Crops to the report header; the dialog shows the full capture. */}
              <ZoomableImage
                src="/images/hackerai-product-finding.jpg"
                alt="HackerAI finding report for the OWASP Juice Shop v20.4.0 lab: Authentication bypass via SQL injection in POST /rest/user/login, High severity, CVSS 3.1 8.2, CWE-89 injection, runtime reproduced, with Export report, Verify, and Retest actions"
                width={1280}
                height={800}
                frameClassName="aspect-[980/478] rounded-xl border border-border bg-card [&_img]:w-[130.6%] [&_img]:max-w-none [&_img]:-translate-x-[11.72%] [&_img]:-translate-y-[6.25%]"
              />
            </div>

            {/* Mobile: stacked explanation. */}
            <ol className="mt-10 divide-y divide-border border-t border-border md:hidden">
              {steps.map((step, index) => (
                <li
                  key={step.label}
                  className="grid grid-cols-[2.25rem_minmax(0,1fr)] py-6"
                >
                  <span className={`pt-1 ${mono}`}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h3 className="font-medium">{step.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {step.copy}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 02 · Where it runs */}
        <section className={sectionClassName} aria-labelledby="where-it-runs">
          <div className={`${container} ${sectionPadding}`}>
            <SectionIntro
              id="where-it-runs"
              label="02 · Where it runs"
              title="Full control, wherever it runs."
            >
              Local or cloud, per task. You define the environment and how much
              the agent may do on its own.
            </SectionIntro>

            {/* Desktop and half-screen comparison. */}
            <table className="mt-14 hidden w-full border-collapse text-left text-sm md:table lg:mt-16">
              <caption className="sr-only">
                Local and cloud Agent execution compared
              </caption>
              <thead>
                <tr className="border-t border-border">
                  <td className="w-[22%]" />
                  <th scope="col" className="py-5 pr-8 align-top font-normal">
                    <span className="block text-base font-semibold">
                      On your machine
                    </span>
                    <span className={`mt-1 block uppercase ${mono}`}>
                      Local · Included on Free
                    </span>
                  </th>
                  <th scope="col" className="py-5 align-top font-normal">
                    <span className="block text-base font-semibold">
                      In the cloud
                    </span>
                    <span className={`mt-1 block uppercase ${mono}`}>
                      Cloud agents · Pro and above
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.label} className="border-t border-border">
                    <th
                      scope="row"
                      className={`py-6 pr-6 align-top font-normal ${mono}`}
                    >
                      {row.label}
                    </th>
                    <td
                      className={`py-6 pr-8 align-top leading-6 ${"localEmphasis" in row ? "font-medium text-foreground" : "text-foreground/80"}`}
                    >
                      {row.local}
                    </td>
                    <td className="py-6 align-top leading-6 text-foreground/80">
                      {row.cloud}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <td />
                  <td className="py-6 pr-8">
                    <a
                      href={LOCAL_AGENT_HELP_URL}
                      target="_blank"
                      rel="noreferrer"
                      className={inlineLink}
                    >
                      Local Agent setup guide
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                    </a>
                  </td>
                  <td className="py-6">
                    <Link href="/trust" className={inlineLink}>
                      What we process, and who processes it
                      <ArrowRight className="size-3.5" aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Mobile: one card per environment, caveat kept beside local. */}
            <div className="mt-10 space-y-4 md:hidden">
              <article className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-lg font-semibold">On your machine</h3>
                  <span className={`uppercase ${mono}`}>Free +</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-foreground/80">
                  HackerAI Desktop or the Local Agent CLI connects Agent mode to
                  your own toolchain. Commands run with your user&apos;s
                  privileges.
                </p>
                <p className="mt-4 border-l-2 border-foreground bg-muted/40 px-3 py-2.5 text-sm leading-6 font-medium">
                  No container isolation. Use local mode on a dedicated testing
                  box you control.
                </p>
                <a
                  href={LOCAL_AGENT_HELP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={`mt-4 ${inlineLink}`}
                >
                  Local Agent setup guide
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </article>
              <article className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="text-lg font-semibold">In the cloud</h3>
                  <span className={`uppercase ${mono}`}>Pro +</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-foreground/80">
                  Cloud Agent sessions run terminal and browser actions in an
                  isolated sandbox we host. Delete it whenever you like from
                  Settings.
                </p>
                <Link href="/trust" className={`mt-4 ${inlineLink}`}>
                  What we process, and who processes it
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </article>
            </div>

            {/* Guardrails: permission levels, then network access as a separate control. */}
            <div className="mt-14 md:mt-12 md:rounded-xl md:border md:border-border md:bg-card/40">
              <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
                <div className="md:flex md:items-baseline md:gap-3 md:border-b md:border-border md:p-6 lg:block lg:border-b-0">
                  <h3 className="text-lg font-semibold md:shrink-0 md:text-base">
                    You set the guardrails.
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground md:mt-0 lg:mt-2">
                    Pick a permission level per task. Change it any time from
                    the task input.
                  </p>
                </div>
                <dl className="mt-6 space-y-5 md:mt-0 md:grid md:grid-cols-3 md:space-y-0 md:divide-x md:divide-border lg:border-l lg:border-border">
                  {permissionLevels.map((level) => (
                    <div key={level.label} className="md:p-6">
                      <dt className="font-mono text-xs text-foreground">
                        {level.label}
                      </dt>
                      <dd className="mt-1.5 text-sm leading-6 text-muted-foreground">
                        {level.copy}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="mt-8 border-t border-border pt-6 md:mt-0 md:pt-0 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
                <h3 className="font-mono text-xs text-foreground md:px-6 md:pt-6 lg:pb-6">
                  Cloud network access
                </h3>
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground md:px-6 md:pb-6 lg:mt-0 lg:pt-6">
                  Separate from permissions. In Settings &gt; Agents, choose
                  Internet access, Allowed destinations only (domains, wildcard
                  subdomains, IPv4 addresses or ranges), or No internet for all
                  tasks in your cloud workspace.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* 03 · What to expect */}
        <section className={sectionClassName} aria-labelledby="what-to-expect">
          <div
            className={`${container} grid gap-10 py-14 md:py-24 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 lg:py-32`}
          >
            <div>
              <p className={eyebrow}>03 · What to expect</p>
              <h2
                id="what-to-expect"
                className={`mt-5 max-sm:text-[1.6rem] ${sectionTitle}`}
              >
                Proof, not promises.
              </h2>
              <p className={`mt-5 max-w-[460px] ${lead}`}>
                HackerAI speeds up security work. It does not replace your
                judgment, your authorization, or your validation.
              </p>
            </div>
            <ol className="divide-y divide-border">
              {expectations.map((item, index) => (
                <li
                  key={item.title}
                  className="grid grid-cols-[2.25rem_minmax(0,1fr)] py-6 first:pt-0 lg:first:pt-6"
                >
                  <span className={`pt-1 ${mono}`} aria-hidden="true">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <div>
                    <h3 className="font-medium">{item.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {item.copy}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 04 · Platforms */}
        <section className={sectionClassName} aria-labelledby="platforms">
          <div
            className={`${container} grid pt-14 md:grid-cols-[minmax(0,1fr)_296px] md:gap-12 md:pt-24 lg:grid-cols-2 lg:gap-16 lg:pt-28`}
          >
            <div className="pb-14 md:self-center md:pb-24 lg:pb-28">
              <p className={eyebrow}>04 · Platforms</p>
              <h2
                id="platforms"
                className={`mt-5 max-sm:text-[1.6rem] ${sectionTitle}`}
              >
                Web, desktop, and mobile.
              </h2>
              <p className={`mt-5 max-w-[520px] ${lead}`}>
                Start a task in the browser. Install HackerAI Desktop when you
                want to connect local tools. Pick up the same task on your phone
                from the mobile web app.
              </p>
              <Link
                href="/download"
                className="mt-6 inline-flex items-center gap-2 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:mt-8 md:h-10 md:rounded-md md:border md:border-border md:px-4 md:no-underline md:hover:bg-accent"
              >
                View all downloads
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            {/* The phone frame runs into the section border. */}
            <div className="hidden md:block md:self-end lg:justify-self-center">
              <div className="w-[296px] lg:w-[340px]">
                <ZoomableImage
                  src="/images/hackerai-product-findings-mobile.jpg"
                  alt="HackerAI Findings list on a phone showing one High 8.2 finding: Authentication bypass via SQL injection in POST /rest/user/login (OWASP Juice Shop v20.4.0), runtime reproduced and active"
                  width={390}
                  height={844}
                  frameClassName="aspect-[390/592] rounded-t-[28px] border border-b-0 border-border bg-card"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Closing CTA */}
        <section aria-labelledby="closing-cta">
          <div
            className={`${container} pt-14 pb-12 md:pt-28 md:pb-14 lg:pt-32`}
          >
            <div className="sm:mx-auto sm:max-w-2xl sm:text-center">
              <h2
                id="closing-cta"
                className="text-[1.6rem] font-semibold leading-[1.05] tracking-[-0.05em] text-balance sm:text-[clamp(2.1rem,4.5vw,3.6rem)]"
              >
                Point it at your next target.
              </h2>
              <p
                className={`mt-5 sm:mx-auto sm:max-w-[560px] sm:text-lg ${lead}`}
              >
                No setup to speak of. Sign up, pick your target, and run your
                first task in the browser. Free needs no payment method.
              </p>
              <div className="mt-8 sm:flex sm:justify-center">
                <PrimaryActions hidePricingOnMobile />
              </div>
            </div>
            <div className="mt-10 flex flex-wrap items-baseline gap-x-3 gap-y-2 text-sm text-muted-foreground sm:mt-24 sm:justify-between sm:border-t sm:border-border sm:pt-8">
              <p>
                <span className="sm:hidden">Verify the details yourself:</span>
                <span className="max-sm:hidden">
                  Verify the details yourself. Source code, guidance, status,
                  and subprocessors are public.
                </span>
              </p>
              <ul className="flex flex-wrap gap-x-4 gap-y-2 sm:gap-x-6">
                {officialLinks.map(({ href, label }) => (
                  <li key={href}>
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:no-underline"
                    >
                      {label}
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>
      <PublicSiteFooter redesign />
    </div>
  );
}
