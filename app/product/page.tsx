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
  HardDrive,
  MonitorCog,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";

import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import { PublicSiteHeader } from "@/components/public/PublicSiteHeader";
import { JsonLd } from "@/components/seo/JsonLd";
import { Button } from "@/components/ui/button";
import {
  GITHUB_URL,
  HELP_CENTER_URL,
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
    copy: "Use focused chat for analysis or let Agent mode plan and carry out longer security workflows with tool access.",
  },
  {
    icon: Terminal,
    title: "Terminal and browser tools",
    copy: "Run commands, inspect output, browse pages, and keep tool evidence alongside the task conversation.",
  },
  {
    icon: FileUp,
    title: "Files and long context",
    copy: "Upload reports, screenshots, source files, and structured data so the model can work from the material you provide.",
  },
  {
    icon: Search,
    title: "Security-focused models",
    copy: "Choose from available AI models and keep the investigation, tool output, and findings in one task workspace.",
  },
] as const;

const officialLinks = [
  { href: GITHUB_URL, label: "Source code", icon: GitBranch },
  { href: HELP_CENTER_URL, label: "Help Center", icon: ExternalLink },
  { href: STATUS_PAGE_URL, label: "Service status", icon: ExternalLink },
] as const;

export default function ProductPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <JsonLd data={SOFTWARE_APPLICATION_JSON_LD} />
      <PublicSiteHeader />
      <main>
        <section className="border-b border-border/80">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                AI-assisted penetration testing
              </p>
              <h1 className="mt-3 text-4xl font-semibold leading-tight sm:text-5xl">
                HackerAI
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-8 text-muted-foreground">
                A task workspace for individual security practitioners who need
                AI reasoning, terminal and browser tools, file analysis, and a
                clear choice between local and cloud execution.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link href="/signup">
                    Start free
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/pricing">View pricing</Link>
                </Button>
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-2xl shadow-black/15">
              <Image
                src="/images/hackerai-workspace.png"
                alt="HackerAI task workspace showing a security workflow"
                width={1440}
                height={900}
                priority
                className="h-auto w-full"
              />
            </div>
          </div>
        </section>

        <section className="border-b border-border/80 bg-card/30">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-18">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-semibold">One security workspace</h2>
              <p className="mt-3 leading-7 text-muted-foreground">
                HackerAI is designed for authorized security assessments, bug
                bounty research, study, and technical investigation. You remain
                responsible for authorization, scope, and reviewing results.
              </p>
            </div>
            <div className="mt-9 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
              {capabilities.map(({ icon: Icon, title, copy }) => (
                <article key={title} className="bg-background p-6">
                  <Icon className="size-5" aria-hidden="true" />
                  <h3 className="mt-5 font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {copy}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-border/80">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-18">
            <div className="grid gap-10 lg:grid-cols-2">
              <div>
                <MonitorCog className="size-6" aria-hidden="true" />
                <h2 className="mt-4 text-2xl font-semibold">Run locally</h2>
                <p className="mt-3 leading-7 text-muted-foreground">
                  HackerAI Desktop and CLI can connect Agent mode to your own
                  machine. Commands run with your user&apos;s privileges and are
                  not container-isolated, so local mode is best used on a
                  dedicated testing environment that you control.
                </p>
                <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
                  <HardDrive className="size-4" />
                  Your machine, your tools, your local environment
                </div>
              </div>
              <div>
                <Cloud className="size-6" aria-hidden="true" />
                <h2 className="mt-4 text-2xl font-semibold">
                  Run in the cloud
                </h2>
                <p className="mt-3 leading-7 text-muted-foreground">
                  Cloud Agent sessions run terminal and browser actions in an
                  isolated E2B sandbox. Cloud sandboxes, uploaded files, and
                  task context are processed by HackerAI and the subprocessors
                  documented on the Trust page.
                </p>
                <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
                  <ShieldCheck className="size-4" />
                  Isolated execution with documented data boundaries
                </div>
              </div>
            </div>
            <Button asChild variant="outline" className="mt-9">
              <Link href="/trust">Read Security &amp; Trust</Link>
            </Button>
          </div>
        </section>

        <section className="border-b border-border/80 bg-card/30">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-18 lg:grid-cols-[1fr_320px] lg:items-center">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-semibold">
                Web, desktop, and mobile
              </h2>
              <p className="mt-3 leading-7 text-muted-foreground">
                Start a task in the browser, install HackerAI Desktop when you
                want to connect local tools, or use the mobile app to review and
                continue work away from your desk.
              </p>
              <Button asChild variant="outline" className="mt-6">
                <Link href="/download">View all downloads</Link>
              </Button>
            </div>
            <div className="mx-auto w-full max-w-[280px] overflow-hidden rounded-lg border border-border bg-card shadow-xl shadow-black/15">
              <Image
                src="/images/hackerai-mobile.png"
                alt="HackerAI mobile web workspace"
                width={390}
                height={844}
                className="h-auto w-full"
              />
            </div>
          </div>
        </section>

        <section>
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-18">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <h2 className="text-3xl font-semibold">Verify the details</h2>
                <p className="mt-3 leading-7 text-muted-foreground">
                  Review the public source code, operating guidance, service
                  status, privacy policy, and subprocessors before choosing an
                  execution mode.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                {officialLinks.map(({ href, label, icon: Icon }) => (
                  <Button key={href} asChild variant="outline">
                    <a href={href} target="_blank" rel="noreferrer">
                      <Icon className="size-4" />
                      {label}
                    </a>
                  </Button>
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
