import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Cloud,
  ExternalLink,
  FileUp,
  GitBranch,
  MonitorCog,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";

import Header from "@/app/components/Header";
import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
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

export const metadata: Metadata = {
  ...canonicalMetadata("/product"),
  title: "Product | HackerAI",
  description,
  openGraph: {
    title: "HackerAI Product",
    description,
    type: "website",
    url: "/product",
    images: ["/images/hackerai-workspace.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "HackerAI Product",
    description,
    images: ["/images/hackerai-workspace.png"],
  },
};

export const dynamic = "force-static";

const capabilities = [
  {
    icon: Bot,
    title: "Point It at a Target. It Does the Work.",
    copy: "Ask for focused analysis, or switch to Agent and it plans and runs multi-step work with the tools it needs. The more context you give it, the further it gets.",
  },
  {
    icon: Terminal,
    title: "Real Tools. Raw Output.",
    copy: "A terminal and a browser are in the loop. It runs the commands, opens the pages, and shows you the output as it came back, not a summary of it.",
  },
  {
    icon: FileUp,
    title: "Your Context. Its Starting Point.",
    copy: "Drop in reports, screenshots, source, and data. HackerAI works from what you give it instead of guessing at your environment.",
  },
  {
    icon: Search,
    title: "Every Finding, Traced End to End.",
    copy: "Commands, output, notes, and findings stay attached to the task. Every claim in your write-up points back to what actually ran.",
  },
] as const;

const expectations = [
  {
    title: "You Validate. It Assists.",
    copy: "AI output and tool actions can be incomplete or wrong. Confirm evidence and impact before you report or act on it.",
  },
  {
    title: "Nothing Local Until You Say So.",
    copy: "Commands only run on your machine after you connect HackerAI Desktop or the Local Agent CLI.",
  },
  {
    title: "Plans Set the Limits.",
    copy: "Model access, included usage, files, context, and cloud-agent capacity depend on your plan and current availability.",
  },
] as const;

const officialLinks = [
  { href: GITHUB_URL, label: "Source code", icon: GitBranch },
  { href: HELP_CENTER_URL, label: "Help Center", icon: ExternalLink },
  { href: STATUS_PAGE_URL, label: "Status page", icon: ExternalLink },
] as const;

const sectionTitle = "text-3xl font-medium tracking-tight sm:text-4xl";
const sectionLead = "mt-4 text-lg leading-8 text-muted-foreground";
const card = "rounded-xl border border-border bg-card p-6";
const inlineLink =
  "mt-5 inline-flex items-center gap-2 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export default function ProductPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <JsonLd data={SOFTWARE_APPLICATION_JSON_LD} />
      <Header currentPath="/product" />
      <main>
        {/* Hero */}
        <section className="border-b border-border/80">
          <div className="mx-auto max-w-6xl px-4 pt-16 pb-14 sm:px-6 sm:pt-24 sm:pb-20">
            <div className="mx-auto max-w-3xl text-center">
              <h1 className="text-5xl font-medium leading-[1.05] tracking-tight text-balance sm:text-6xl">
                The AI Agent
                <br className="hidden sm:block" /> for Penetration Testing.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-pretty text-muted-foreground">
                Point it at a target. It runs the recon, the tools, and keeps
                the evidence.
                <br className="hidden sm:block" /> On your machine or in an
                isolated cloud sandbox.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Button asChild size="lg">
                  <Link href="/signup">
                    Start free
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="ghost">
                  <Link href="/pricing">
                    View pricing
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </div>
            </div>
            <div className="mx-auto mt-14 max-w-5xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-black/30">
              <Image
                src="/images/hackerai-workspace.png"
                alt="HackerAI Agent mode running a service scan, with reasoning and commands shown in the task"
                width={1440}
                height={900}
                priority
                className="h-auto w-full"
              />
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section className="border-b border-border/80">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className={sectionTitle}>
                Findings Are Cheap. Proof Is the Job.
              </h2>
              <p className={sectionLead}>
                Scanners produce lists. Pentesters, bug bounty hunters, and red
                teams need reproducible evidence and a write-up that holds up.
                HackerAI keeps the whole engagement in one task, from first scan
                to final report.
              </p>
            </div>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {capabilities.map(({ icon: Icon, title, copy }) => (
                <article key={title} className={card}>
                  <Icon className="size-5" aria-hidden="true" />
                  <h3 className="mt-5 text-lg font-medium">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {copy}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Execution */}
        <section className="border-b border-border/80">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <div className="max-w-2xl">
              <h2 className={sectionTitle}>Full Control, Wherever It Runs.</h2>
              <p className={sectionLead}>
                Local or cloud, per task. You define the environment and how
                much the agent may do on its own.
              </p>
            </div>
            <div className="mt-12 grid gap-4 lg:grid-cols-3">
              <article className={card}>
                <SlidersHorizontal className="size-5" aria-hidden="true" />
                <h3 className="mt-5 text-xl font-medium">
                  You Set the Guardrails.
                </h3>
                <p className="mt-3 leading-7 text-muted-foreground">
                  Pick a permission level per task: approve every action, let it
                  auto-review, or give it full access. Change it any time from
                  the task input.
                </p>
              </article>
              <article className={card}>
                <MonitorCog className="size-5" aria-hidden="true" />
                <h3 className="mt-5 text-xl font-medium">On Your Machine.</h3>
                <p className="mt-3 leading-7 text-muted-foreground">
                  HackerAI Desktop and the Local Agent CLI connect Agent mode to
                  your own toolchain. Commands run with your user&apos;s
                  privileges and without container isolation, so use local mode
                  on a dedicated testing box you control.
                </p>
                <a
                  href={LOCAL_AGENT_HELP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={inlineLink}
                >
                  Local Agent setup guide
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </article>
              <article className={card}>
                <Cloud className="size-5" aria-hidden="true" />
                <h3 className="mt-5 text-xl font-medium">In the Cloud.</h3>
                <p className="mt-3 leading-7 text-muted-foreground">
                  Cloud Agent sessions run terminal and browser actions in an
                  isolated sandbox we host. Delete it whenever you like from
                  Settings. What we process, and who processes it, is spelled
                  out on the Security &amp; Trust page.
                </p>
                <Link href="/trust" className={inlineLink}>
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  Read Security &amp; Trust
                </Link>
              </article>
            </div>
          </div>
        </section>

        {/* Expectations */}
        <section className="border-b border-border/80">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <div className="max-w-2xl">
              <h2 className={sectionTitle}>Proof, Not Promises.</h2>
              <p className={sectionLead}>
                HackerAI speeds up security work. It does not replace your
                judgment, your authorization, or your validation.
              </p>
            </div>
            <div className="mt-12 grid gap-4 lg:grid-cols-3">
              {expectations.map(({ title, copy }) => (
                <article key={title} className={card}>
                  <h3 className="text-lg font-medium">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {copy}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Platforms */}
        <section className="border-b border-border/80">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1fr_320px] lg:items-center">
            <div className="max-w-2xl">
              <h2 className={sectionTitle}>Web, Desktop, and Mobile.</h2>
              <p className={sectionLead}>
                Start a task in the browser. Install HackerAI Desktop when you
                want to connect local tools. Pick up the same task on your phone
                from the mobile web app.
              </p>
              <Button asChild variant="outline" className="mt-8">
                <Link href="/download">
                  View all downloads
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
            <div className="mx-auto w-full max-w-[280px] overflow-hidden rounded-xl border border-border bg-card shadow-xl shadow-black/30">
              <Image
                src="/images/hackerai-mobile.png"
                alt="HackerAI mobile web app showing the same Agent task on a phone"
                width={390}
                height={844}
                className="h-auto w-full"
              />
            </div>
          </div>
        </section>

        {/* Closing CTA */}
        <section>
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className={sectionTitle}>Point It at Your Next Target.</h2>
              <p className={sectionLead}>
                No setup to speak of. Sign up, pick your target, and run your
                first task in the browser. Free needs no payment method.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Button asChild size="lg">
                  <Link href="/signup">
                    Start free
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="ghost">
                  <Link href="/pricing">
                    View pricing
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </div>
            </div>
            <div className="mt-14 flex flex-col items-center gap-4 border-t border-border pt-8 text-sm text-muted-foreground sm:flex-row sm:justify-between">
              <p>
                Verify the details yourself. Source code, guidance, status, and
                subprocessors are public.
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {officialLinks.map(({ href, label, icon: Icon }) => (
                  <a
                    key={href}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-sm font-medium text-foreground hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {label}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>
      <PublicSiteFooter />
    </div>
  );
}
