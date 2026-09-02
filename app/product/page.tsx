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
  "See how HackerAI combines security-focused AI, Agent mode, terminal and browser tools, files, and local or cloud execution for authorized penetration testing.";

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
    title: "Ask and Agent modes",
    copy: "Ask for focused analysis. Switch to Agent when you want the model to plan and run a longer workflow with tools.",
  },
  {
    icon: Terminal,
    title: "Terminal and browser",
    copy: "Run commands, read output, and browse targets. Every tool call stays in the task alongside the conversation.",
  },
  {
    icon: FileUp,
    title: "Files and long context",
    copy: "Upload reports, screenshots, source, and structured data. The model works from what you give it.",
  },
  {
    icon: Search,
    title: "Evidence and reporting",
    copy: "Notes, tool output, and findings live in one task. Turn validated evidence into report-ready material.",
  },
] as const;

const expectations = [
  {
    title: "Review every result",
    copy: "AI output and tool actions can be incomplete or wrong. Validate evidence and impact before you report or act.",
  },
  {
    title: "Local tools are opt-in",
    copy: "Nothing runs on your machine until you connect HackerAI Desktop or the Local Agent CLI.",
  },
  {
    title: "Access varies by plan",
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
              <h1 className="text-5xl font-medium leading-[1.05] tracking-tight sm:text-6xl">
                Hands-On Pentesting
                <br className="hidden sm:block" /> With an AI Agent.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
                Recon, terminal, browser, and files in one workspace.
                <br className="hidden sm:block" /> Run it on your machine or in
                an isolated cloud sandbox.
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
                alt="HackerAI Agent mode running a scan against an authorized target, with terminal output shown in the task"
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
              <h2 className={sectionTitle}>One workspace for the engagement</h2>
              <p className={sectionLead}>
                Ask questions, run tools, and keep evidence in the same task.
                Built for authorized assessments, bug bounty research, study,
                and technical investigation.
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
              <h2 className={sectionTitle}>Runs where you need it</h2>
              <p className={sectionLead}>
                Choose local or cloud execution per task. The boundaries are
                documented, not implied.
              </p>
            </div>
            <div className="mt-12 grid gap-4 lg:grid-cols-2">
              <article className={card}>
                <MonitorCog className="size-5" aria-hidden="true" />
                <h3 className="mt-5 text-xl font-medium">On your machine</h3>
                <p className="mt-3 leading-7 text-muted-foreground">
                  HackerAI Desktop and the Local Agent CLI connect Agent mode to
                  your own tools. Commands run with your user&apos;s privileges
                  and without container isolation, so use local mode on a
                  dedicated testing environment that you control.
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
                <h3 className="mt-5 text-xl font-medium">In the cloud</h3>
                <p className="mt-3 leading-7 text-muted-foreground">
                  Cloud Agent sessions run terminal and browser actions in an
                  isolated E2B sandbox. Sandboxes, uploaded files, and task
                  context are processed by HackerAI and the subprocessors listed
                  on the Security &amp; Trust page.
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
              <h2 className={sectionTitle}>What to expect</h2>
              <p className={sectionLead}>
                HackerAI speeds up security work. It does not replace
                practitioner judgment, authorization, or independent validation.
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
              <h2 className={sectionTitle}>Web, desktop, and mobile</h2>
              <p className={sectionLead}>
                Start a task in the browser, install HackerAI Desktop when you
                want to connect local tools, and pick up the same task on your
                phone from the mobile web app.
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
              <h2 className={sectionTitle}>Start in minutes</h2>
              <p className={sectionLead}>
                Sign up, pick a target you are authorized to test, and run your
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
