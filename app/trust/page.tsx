import type { Metadata } from "next";
import {
  Activity,
  BadgeCheck,
  Bot,
  Bug,
  Code,
  CreditCard,
  Database,
  ExternalLink as ExternalLinkIcon,
  FileText,
  Globe,
  KeyRound,
  Network,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import Header from "@/app/components/Header";
import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import {
  HELP_CENTER_URL as DEFAULT_HELP_CENTER_URL,
  PUBLIC_PAGE_LAST_MODIFIED,
  STATUS_PAGE_URL,
  canonicalMetadata,
  formatPublicPageDate,
} from "@/lib/seo/site";

export const metadata: Metadata = {
  ...canonicalMetadata("/trust"),
  title: "Security & Trust | HackerAI",
  description:
    "How HackerAI handles your data: AI providers, sandbox execution, storage, billing, account security, and subprocessors.",
  openGraph: {
    title: "Security & Trust | HackerAI",
    description:
      "How HackerAI handles your data: AI providers, sandbox execution, storage, billing, account security, and subprocessors.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Security & Trust | HackerAI",
    description:
      "How HackerAI handles your data: AI providers, sandbox execution, storage, billing, account security, and subprocessors.",
  },
};

export const dynamic = "force-static";

const HELP_CENTER_URL =
  process.env.NEXT_PUBLIC_HELP_CENTER_URL || DEFAULT_HELP_CENTER_URL;

interface Subprocessor {
  name: string;
  purpose: string;
  dataCategories: string;
}

const MODEL_REQUEST_DATA =
  "Prompts, conversation context, file content and images, tool output";

const subprocessors: Subprocessor[] = [
  {
    name: "OpenRouter",
    purpose: "Routes most model requests to an upstream model host",
    dataCategories: MODEL_REQUEST_DATA,
  },
  {
    name: "Upstream model hosts (via OpenRouter)",
    purpose:
      "Generate responses for models routed through OpenRouter; the host can differ from the model's author",
    dataCategories: MODEL_REQUEST_DATA,
  },
  {
    name: "Inference.net",
    purpose: "Serves some security-tuned models directly, without OpenRouter",
    dataCategories: MODEL_REQUEST_DATA,
  },
  {
    name: "Abliteration.ai",
    purpose:
      "Serves abliterated models directly, without OpenRouter, and handles some fallback requests",
    dataCategories: MODEL_REQUEST_DATA,
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
    name: "2Captcha",
    purpose: "Solves CAPTCHAs the agent encounters while browsing",
    dataCategories:
      "Page URL, CAPTCHA site key and challenge parameters, browser user agent",
  },
  {
    name: "E2B",
    purpose: "Cloud sandboxes (US or EU, following the workspace region)",
    dataCategories: "Commands, command output, files inside the sandbox",
  },
  {
    name: "Convex",
    purpose: "Primary application database",
    dataCategories: "Account data, tasks, messages, files, settings",
  },
  {
    name: "Amazon Web Services (S3)",
    purpose:
      "File uploads and downloadable copies (US or EU, with a US fallback)",
    dataCategories: "Uploaded files and downloadable Agent file copies",
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
    purpose: "Product analytics, eligible session replay, and error tracking",
    dataCategories:
      "Usage events, diagnostic data, and interface recordings where enabled",
  },
  {
    name: "Intercom",
    purpose: "Customer support messaging",
    dataCategories:
      "Account identifier, email, name, and support messages and attachments you send",
  },
  {
    name: "Cloudflare Turnstile",
    purpose: "Bot verification on the abuse report form",
    dataCategories: "Browser and device signals, verification token",
  },
  {
    name: "Trigger.dev",
    purpose:
      "Background Agent execution (US or EU; Cloud runs follow the workspace region, Local and Desktop runs follow the connection location)",
    dataCategories: "Task payloads including conversation context",
  },
  {
    name: "Vercel",
    purpose: "Application hosting",
    dataCategories: "Request data processed by the web application",
  },
];

interface SectionProps {
  id?: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}

const Section = ({ id, icon: Icon, title, children }: SectionProps) => (
  <section
    id={id}
    className="rounded-xl border border-border bg-card p-6 sm:p-8"
  >
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

function TrustContent() {
  return (
    <main className="bg-background px-4 py-14 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-4xl">
        {/* Hero */}
        <header className="mb-12 text-center">
          <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-2xl border border-border bg-card shadow-sm">
            <ShieldCheck
              className="size-7 text-foreground"
              aria-hidden="true"
            />
          </div>
          <h1 className="text-5xl font-medium leading-[1.05] tracking-tight text-foreground sm:text-6xl">
            Security &amp; Trust
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
            HackerAI is an AI agent for penetration testing and security work.
            This page describes the data we process, where agent code runs, and
            the services we rely on to operate.
          </p>
          <p className="mt-6 inline-flex items-center rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            Last updated{" "}
            <time className="ml-1" dateTime={PUBLIC_PAGE_LAST_MODIFIED.trust}>
              {formatPublicPageDate(PUBLIC_PAGE_LAST_MODIFIED.trust)}
            </time>
          </p>
        </header>

        <div className="space-y-6">
          <Section icon={Database} title="Data we process">
            <p>Depending on how you use HackerAI, the service processes:</p>
            <CheckList
              items={[
                "Prompts and task messages you send to the agent",
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
              HackerAI sends your prompt, relevant conversation context, file
              content, images, and tool results to the company serving the
              model. Most model requests go through OpenRouter and an upstream
              model host. The host may be the model&apos;s developer, such as
              xAI, DeepSeek, Moonshot AI, Z.ai, or MiniMax, or another company
              serving the same model. See the{" "}
              <InlineLink href="https://openrouter.ai/privacy">
                OpenRouter privacy policy
              </InlineLink>{" "}
              and{" "}
              <InlineLink href="https://openrouter.ai/docs/guides/privacy/provider-logging">
                upstream host data policies
              </InlineLink>
              .
            </p>
            <p>
              Some security-tuned models are served directly by Inference.net,
              and abliterated models are served directly by Abliteration.ai,
              without passing through OpenRouter. See the{" "}
              <InlineLink href="https://inference.net/privacy-policy/">
                Inference.net privacy policy
              </InlineLink>{" "}
              and{" "}
              <InlineLink href="https://abliteration.ai/privacy-policy">
                Abliteration.ai privacy policy
              </InlineLink>
              .
            </p>
            <p>
              More than one provider can process a request. If a model fails or
              is unavailable, HackerAI may use a fallback on a different route;
              for example, Inference.net can fall back to Abliteration.ai.
              Uploaded images and browser screenshots may also be processed by a
              separate image model. The selected model does not identify every
              company that may receive relevant task content.
            </p>
            <p>
              When the agent searches the web or opens a URL, Perplexity
              processes search queries and Jina AI retrieves page content.
              OpenAI screens message content for moderation. When the agent uses
              CAPTCHA solving, 2Captcha receives the page URL, site key,
              challenge parameters, and browser user agent needed to solve it.
            </p>
            <p>
              Each provider processes data under its own terms. Retention and
              model training policies vary by provider, so we do not make a
              blanket no-training or zero-retention guarantee. Refer to the
              provider policies linked above.
            </p>
          </Section>

          <Section icon={FileText} title="Model training and data licensing">
            <p>
              A future program may use eligible task content to train and
              evaluate AI models, including paid licensing to AI partners. This
              program is not active, and partner data collection has not
              started. See our{" "}
              <InlineLink href="/privacy-policy#data-contributions">
                Privacy Policy
              </InlineLink>{" "}
              for the notice and consent requirements that would apply before
              any collection.
            </p>
          </Section>

          <div className="grid gap-6 md:grid-cols-2">
            <Section icon={Terminal} title="Execution environments">
              <p>
                By default, terminal and browser actions run in an isolated E2B
                cloud sandbox. You can delete your sandboxes at any time from
                Settings &rarr; Data controls.
              </p>
              <p>
                Local and Desktop modes run commands directly on your machine
                with your user&apos;s privileges and{" "}
                <strong className="text-foreground">no E2B isolation</strong>,
                so we recommend them only on machines dedicated to testing. They
                are not offline: relevant commands, output, file content, and
                screenshots are still sent to HackerAI and the model providers
                above.
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

          <Section icon={Globe} title="Where your data is processed">
            <p>
              Your connection&apos;s IP address normally determines the initial
              region of a new cloud workspace: Europe uses our EU region
              (Frankfurt, eu-central-1), and other connections use a US region.
              Once a cloud workspace exists, Cloud Agent runs use its saved
              region even when your IP address changes. If you have existing
              workspaces in both the US and Europe, you may need to choose one
              or contact support.
            </p>
            <p>
              New file uploads from the app normally follow your current
              connection location. Downloadable file copies uploaded by Agent
              runs normally follow that run&apos;s region. Uploads can use a US
              fallback location when regional placement is unavailable. Files
              that stay inside a Local or Desktop workspace remain on your
              connected computer. Changing your IP address through a VPN or
              travel does not move existing workspaces or stored files.
            </p>
            <p>
              The primary database, AI model providers, web search, content
              moderation, authentication, billing, and analytics are not
              regional. See the{" "}
              <InlineLink href="/privacy-policy">Privacy Policy</InlineLink> for
              international processing.
            </p>
          </Section>

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
                  "Delete individual tasks, or all tasks at once",
                  "Delete your terminal sandboxes",
                  "Revoke links to tasks you have shared",
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
            <Section
              id="responsible-disclosure"
              icon={Bug}
              title="Responsible disclosure"
            >
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
          <p className="mb-6 text-sm leading-7 text-muted-foreground">
            Suspected misuse of HackerAI, or a restriction you want reviewed?{" "}
            <a
              href="/abuse"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Report abuse or appeal a decision
            </a>
            . You do not need a HackerAI account.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { href: "/privacy-policy", label: "Privacy Policy" },
              { href: "/terms-of-service", label: "Terms of Service" },
              { href: HELP_CENTER_URL, label: "Help Center" },
              { href: STATUS_PAGE_URL, label: "Status page" },
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
    </main>
  );
}

export default function TrustPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <Header currentPath="/trust" />
      <TrustContent />
      <PublicSiteFooter />
    </div>
  );
}
