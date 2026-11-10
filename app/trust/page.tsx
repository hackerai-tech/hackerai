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

interface ModelRoute {
  title: string;
  scope: string;
  description: string;
  policies: { href: string; label: string }[];
}

const modelRoutes: ModelRoute[] = [
  {
    title: "Through OpenRouter",
    scope: "Most models",
    description:
      "OpenRouter receives the request and forwards it to an upstream host for that model. The host can be the model's author, such as xAI, DeepSeek, Moonshot AI, Z.ai, or MiniMax, or another company serving the same model. Both OpenRouter and that host process the request, and each host sets its own logging, retention, and training terms.",
    policies: [
      { href: "https://openrouter.ai/privacy", label: "OpenRouter privacy" },
      {
        href: "https://openrouter.ai/docs/guides/privacy/provider-logging",
        label: "Upstream host data policies",
      },
    ],
  },
  {
    title: "Direct to Inference.net",
    scope: "Some security-tuned models",
    description:
      "Requests go from HackerAI to Inference.net without passing through OpenRouter.",
    policies: [
      {
        href: "https://inference.net/privacy-policy/",
        label: "Inference.net privacy policy",
      },
    ],
  },
  {
    title: "Direct to Abliteration.ai",
    scope: "Abliterated models",
    description:
      "Requests go from HackerAI to Abliteration.ai without passing through OpenRouter.",
    policies: [
      {
        href: "https://abliteration.ai/privacy-policy",
        label: "Abliteration.ai privacy policy",
      },
    ],
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

          <Section
            id="ai-model-providers"
            icon={Bot}
            title="AI model providers"
          >
            <p>
              To answer a request, HackerAI sends your prompt, relevant
              conversation context, tool results, and any images in the request
              to the company serving the model. The route depends on the model:
            </p>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {modelRoutes.map((route) => (
                <li
                  key={route.title}
                  className="flex flex-col gap-2.5 p-4 sm:flex-row sm:gap-6 sm:px-5"
                >
                  <div className="flex shrink-0 flex-col gap-1 sm:w-52">
                    <h3 className="font-semibold text-foreground">
                      {route.title}
                    </h3>
                    <p className="font-mono text-xs leading-5">{route.scope}</p>
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <p>{route.description}</p>
                    <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
                      {route.policies.map((policy) => (
                        <InlineLink key={policy.href} href={policy.href}>
                          {policy.label}
                        </InlineLink>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <p>
              <strong className="text-foreground">
                More than one provider can process a request.
              </strong>{" "}
              If the selected model fails or is unavailable, HackerAI may retry
              with a fallback model on a different route; for example, an
              Inference.net request can fall back to Abliteration.ai. Images you
              upload and browser screenshots the agent captures are sent to
              whichever model handles the request, and in some cases a separate
              model processes image content. The model you select doesn&apos;t
              always identify every company that receives your request.
            </p>
            <p>
              <strong className="text-foreground">
                Retention and training vary by provider.
              </strong>{" "}
              Each provider processes data under its own terms, so we don&apos;t
              make a blanket no-training or zero-retention guarantee. Check the
              policies linked above.
            </p>
            <p>
              <strong className="text-foreground">
                Search, browsing, and moderation.
              </strong>{" "}
              Perplexity processes web search queries, Jina AI retrieves page
              content, and OpenAI screens message content for moderation. If the
              agent meets a CAPTCHA while browsing, 2Captcha receives the
              details needed to solve it.
            </p>
            <p>
              <strong className="text-foreground">Data licensing.</strong> The
              future model training and data licensing program described in our{" "}
              <InlineLink href="/privacy-policy#data-contributions">
                Privacy Policy
              </InlineLink>{" "}
              is not active.
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
            <div className="overflow-hidden rounded-lg border border-border">
              {/* Explicit roles keep table semantics when narrow screens
                  stack each row into a block. */}
              <table role="table" className="w-full border-collapse text-sm">
                <thead role="rowgroup" className="max-sm:sr-only">
                  <tr
                    role="row"
                    className="border-b border-border bg-muted/60 text-left"
                  >
                    <th
                      role="columnheader"
                      className="px-4 py-3 font-semibold text-foreground"
                    >
                      Provider
                    </th>
                    <th
                      role="columnheader"
                      className="px-4 py-3 font-semibold text-foreground"
                    >
                      Purpose
                    </th>
                    <th
                      role="columnheader"
                      className="px-4 py-3 font-semibold text-foreground"
                    >
                      Data categories
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {subprocessors.map((subprocessor) => (
                    <tr
                      key={subprocessor.name}
                      role="row"
                      className="border-b border-border align-top last:border-b-0 max-sm:block max-sm:space-y-1 max-sm:px-4 max-sm:py-3.5"
                    >
                      <td
                        role="cell"
                        className="px-4 py-3 font-medium text-foreground max-sm:block max-sm:p-0 sm:w-44"
                      >
                        {subprocessor.name}
                      </td>
                      <td
                        role="cell"
                        className="px-4 py-3 max-sm:block max-sm:p-0"
                      >
                        {subprocessor.purpose}
                      </td>
                      <td
                        role="cell"
                        className="px-4 py-3 max-sm:block max-sm:p-0"
                      >
                        <span
                          aria-hidden="true"
                          className="font-medium text-foreground sm:hidden"
                        >
                          Data:{" "}
                        </span>
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
