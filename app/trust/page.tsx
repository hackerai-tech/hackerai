import type { Metadata } from "next";
import {
  Activity,
  BadgeCheck,
  Bot,
  Bug,
  Code,
  CreditCard,
  Crosshair,
  Database,
  ExternalLink as ExternalLinkIcon,
  FileText,
  KeyRound,
  Network,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { PUBLIC_POSITIONING } from "@/lib/marketing/positioning";

export const metadata: Metadata = {
  title: "Security & Trust | HackerAI",
  description:
    "How HackerAI supports technical work and authorized security testing, where provider boundaries apply, and how data, sandboxes, billing, and account security work.",
  openGraph: {
    title: "Security & Trust | HackerAI",
    description:
      "How HackerAI supports technical work and authorized security testing, where provider boundaries apply, and how data, sandboxes, billing, and account security work.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Security & Trust | HackerAI",
    description:
      "How HackerAI supports technical work and authorized security testing, where provider boundaries apply, and how data, sandboxes, billing, and account security work.",
  },
};

export const dynamic = "force-static";

const LAST_UPDATED = "July 16, 2026";

const HELP_CENTER_URL =
  process.env.NEXT_PUBLIC_HELP_CENTER_URL || "https://help.hackerai.co/en/";

const STATUS_PAGE_URL = "https://status.hackerai.co/";

interface Subprocessor {
  name: string;
  purpose: string;
  dataCategories: string;
}

const subprocessors: Subprocessor[] = [
  {
    name: "OpenRouter",
    purpose: "Routes chat requests to third-party AI model providers",
    dataCategories: "Prompts, conversation context, file content, tool output",
  },
  {
    name: "OpenAI",
    purpose: "Content moderation",
    dataCategories: "Message content",
  },
  {
    name: "Perplexity",
    purpose: "Web search performed by the agent",
    dataCategories: "Search queries from agent runs",
  },
  {
    name: "Jina AI",
    purpose: "Webpage content retrieval for the agent",
    dataCategories: "URLs and retrieved page content",
  },
  {
    name: "E2B",
    purpose: "Cloud sandboxes for terminal and browser execution",
    dataCategories: "Commands, command output, files inside the sandbox",
  },
  {
    name: "Convex",
    purpose: "Primary application database",
    dataCategories: "Account data, chats, messages, files, settings",
  },
  {
    name: "Amazon Web Services (S3)",
    purpose: "File storage",
    dataCategories: "Uploaded files",
  },
  {
    name: "Upstash / Redis",
    purpose: "Rate limiting and response stream resumption",
    dataCategories: "Transient identifiers and streaming state",
  },
  {
    name: "WorkOS",
    purpose: "Authentication and account management",
    dataCategories: "Email, name, sessions, MFA enrollment",
  },
  {
    name: "Stripe",
    purpose: "Payments and subscription billing",
    dataCategories: "Billing contact and payment details (held by Stripe)",
  },
  {
    name: "PostHog",
    purpose: "Product analytics and error tracking",
    dataCategories: "Usage events and diagnostic data",
  },
  {
    name: "Trigger.dev",
    purpose: "Background execution of long-running agent tasks",
    dataCategories: "Task payloads including conversation context",
  },
  {
    name: "Vercel",
    purpose: "Application hosting",
    dataCategories: "Request data processed by the web application",
  },
];

interface SectionProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}

const Section = ({ icon: Icon, title, children }: SectionProps) => (
  <section className="rounded-xl border border-border bg-card p-6 sm:p-8">
    <div className="mb-4 flex items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
        <Icon className="size-4.5 text-foreground" />
      </div>
      <h2 className="text-lg font-semibold text-card-foreground sm:text-xl">
        {title}
      </h2>
    </div>
    <div className="space-y-3 text-[15px] leading-relaxed text-muted-foreground">
      {children}
    </div>
  </section>
);

const InlineLink = ({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
  >
    {children}
  </a>
);

const CheckList = ({ items }: { items: React.ReactNode[] }) => (
  <ul className="space-y-2.5">
    {items.map((item, index) => (
      <li key={index} className="flex items-start gap-2.5">
        <ShieldCheck className="mt-1 size-4 shrink-0 text-foreground" />
        <span>{item}</span>
      </li>
    ))}
  </ul>
);

export default function TrustPage() {
  return (
    <div className="min-h-dvh bg-background px-4 py-12 sm:px-6">
      <div className="mx-auto max-w-4xl">
        {/* Hero */}
        <header className="mb-12 text-center">
          <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-2xl border border-border bg-card shadow-sm">
            <ShieldCheck className="size-7 text-foreground" />
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Security &amp; Trust
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            HackerAI is built for practical technical work, including serious,
            authorized security testing. This page explains where provider and
            abuse controls apply and how your data and Agent execution are
            handled.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
              Last updated {LAST_UPDATED}
            </span>
          </div>
        </header>

        <div className="space-y-6">
          <Section icon={Crosshair} title="Authorized Security Testing">
            <p>
              Security is one of HackerAI&apos;s deepest workflows:
              attack-surface mapping, code review, exploit development,
              validation, remediation, and reporting on systems you own or are
              authorized to test.
            </p>
            <p>{PUBLIC_POSITIONING.boundary}</p>
          </Section>

          <Section icon={Database} title="Data we process">
            <p>Depending on how you use HackerAI, the service processes:</p>
            <CheckList
              items={[
                "Prompts and chat messages you send to the agent",
                "Files you upload (PDF, CSV, JSON, TXT, Markdown, DOC/DOCX, and PNG/JPEG/WebP/GIF images), including text extracted from them",
                "URLs and search queries used when the agent browses or searches the web",
                "Terminal commands and their output from agent sandbox sessions",
                "Browser screenshots captured inside the agent sandbox",
                "Notes and custom instructions you save",
                "Account information such as your email address and name",
                "Usage analytics and error diagnostics",
              ]}
            />
          </Section>

          <Section icon={Bot} title="AI model providers">
            <p>
              Chat requests are routed through OpenRouter to the provider behind
              the model you select, such as Anthropic, Google, DeepSeek,
              Moonshot AI, or xAI. Your prompt, relevant conversation context,
              and tool results are sent to that provider to generate a response.
            </p>
            <p>
              When the agent searches the web or opens a URL, search queries are
              processed by Perplexity and page content is retrieved through Jina
              AI. Message content is screened by OpenAI for content moderation.
            </p>
            <p>
              Each provider processes data under its own terms. Whether data is
              used for model training varies by provider, so we don&apos;t make
              a blanket guarantee on this point &mdash; refer to the policies of
              the providers listed below.
            </p>
          </Section>

          <div className="grid gap-6 md:grid-cols-2">
            <Section icon={Terminal} title="Execution environments">
              <p>
                By default, terminal and browser actions run in an isolated E2B
                cloud sandbox tied to your account, separate from our
                application infrastructure. You can delete your sandboxes at any
                time from Settings &rarr; Data controls.
              </p>
              <p>
                A local execution mode is also available. It runs commands
                directly on your machine with your user&apos;s privileges and{" "}
                <strong className="text-foreground">no isolation</strong>, so we
                recommend it only on machines dedicated to testing.
              </p>
            </Section>

            <Section icon={KeyRound} title="Account security">
              <CheckList
                items={[
                  "Authentication is handled by WorkOS AuthKit; we don't operate our own password database",
                  <>
                    Multi-factor authentication (TOTP) is available in Settings
                    &rarr; Security
                  </>,
                  <>
                    Sessions can be revoked per device or across all devices
                    from Settings &rarr; Security
                  </>,
                ]}
              />
            </Section>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <Section icon={CreditCard} title="Billing">
              <p>
                Payments are processed by Stripe; card details never reach our
                servers. Subscriptions can be managed or canceled through the
                billing portal in your account settings, and deleting your
                account cancels any active subscription.
              </p>
            </Section>

            <Section icon={Trash2} title="Data deletion">
              <CheckList
                items={[
                  "Delete individual chats, or all chats at once",
                  "Delete your terminal sandboxes",
                  "Revoke links to chats you have shared",
                  "Delete your account, which removes database records, cancels your Stripe subscription, and deletes your authentication record",
                  "Deleting and recreating an account does not reset usage limits or referral eligibility",
                ]}
              />
            </Section>
          </div>

          <Section icon={Network} title="Subprocessors">
            <p>The following services process data on our behalf:</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/60 text-left">
                    <th className="px-4 py-3 font-semibold text-foreground">
                      Provider
                    </th>
                    <th className="px-4 py-3 font-semibold text-foreground">
                      Purpose
                    </th>
                    <th className="px-4 py-3 font-semibold text-foreground">
                      Data categories
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {subprocessors.map((subprocessor, index) => (
                    <tr
                      key={subprocessor.name}
                      className={
                        index < subprocessors.length - 1
                          ? "border-b border-border align-top"
                          : "align-top"
                      }
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground">
                        {subprocessor.name}
                      </td>
                      <td className="px-4 py-3">{subprocessor.purpose}</td>
                      <td className="px-4 py-3">
                        {subprocessor.dataCategories}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <div className="grid gap-6 md:grid-cols-2">
            <Section icon={Bug} title="Responsible disclosure">
              <p>
                Found a security vulnerability in HackerAI? Report it through
                the <InlineLink href={HELP_CENTER_URL}>help center</InlineLink>.
                We review all good-faith reports. We don&apos;t run a paid bug
                bounty program at this time.
              </p>
            </Section>

            <Section icon={Activity} title="Incident communication">
              <p>
                For availability updates and scheduled maintenance, check the{" "}
                <InlineLink href={STATUS_PAGE_URL}>
                  public status page
                </InlineLink>
                . If an incident affects your data, we notify affected users
                through the service and the help center.
              </p>
            </Section>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <Section icon={Code} title="Source code">
              <p>
                HackerAI is developed in the open. The full application source
                code is public on{" "}
                <InlineLink href="https://github.com/hackerai-tech/hackerai">
                  GitHub
                </InlineLink>
                , including every change we ship. You can review how prompts,
                files, and sandbox sessions are handled directly in the code
                rather than relying on this page alone.
              </p>
            </Section>

            <Section icon={BadgeCheck} title="Compliance">
              <p>
                HackerAI doesn&apos;t currently hold SOC 2, ISO 27001, or other
                third-party certifications. The service is offered in beta, as
                described in our{" "}
                <InlineLink href="/privacy-policy">Privacy Policy</InlineLink>{" "}
                and{" "}
                <InlineLink href="/terms-of-service">
                  Terms of Service
                </InlineLink>
                . We&apos;ll update this page as our compliance program
                develops.
              </p>
            </Section>
          </div>
        </div>

        {/* Related documents */}
        <footer className="mt-12">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { href: "/privacy-policy", label: "Privacy Policy" },
              { href: "/terms-of-service", label: "Terms of Service" },
              { href: HELP_CENTER_URL, label: "Help center" },
              { href: STATUS_PAGE_URL, label: "Status Page" },
            ].map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center justify-between rounded-xl border border-border bg-card px-5 py-4 transition-colors hover:bg-muted/60"
              >
                <span className="flex items-center gap-3 text-sm font-medium text-foreground">
                  <FileText className="size-4 text-muted-foreground" />
                  {link.label}
                </span>
                <ExternalLinkIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </a>
            ))}
          </div>
          <p className="mt-8 text-center text-xs text-muted-foreground">
            Questions about security at HackerAI? Contact us through the{" "}
            <InlineLink href={HELP_CENTER_URL}>help center</InlineLink>.
          </p>
        </footer>
      </div>
    </div>
  );
}
