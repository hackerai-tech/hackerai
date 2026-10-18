import type { Metadata } from "next";
import Link from "next/link";
import {
  PUBLIC_PAGE_LAST_MODIFIED,
  canonicalMetadata,
  formatPublicPageDate,
} from "@/lib/seo/site";

export const metadata: Metadata = {
  ...canonicalMetadata("/privacy-policy"),
  title: "Privacy Policy | HackerAI",
  description:
    "Privacy Policy and data handling practices for HackerAI services.",
  openGraph: {
    title: "Privacy Policy | HackerAI",
    description:
      "Privacy Policy and data handling practices for HackerAI services.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Privacy Policy | HackerAI",
    description:
      "Privacy Policy and data handling practices for HackerAI services.",
  },
};

export const dynamic = "force-static";

const linkClassName =
  "font-medium text-foreground underline underline-offset-4 hover:text-foreground/80";

export default function PrivacyPolicyPage() {
  return (
    <div className="px-4 py-8 pb-16 md:px-0">
      <main className="container mx-auto max-w-2xl rounded-md border bg-card px-4 py-8 shadow-lg sm:px-8">
        <h1 className="text-center text-3xl font-semibold text-card-foreground">
          HackerAI Privacy Policy
        </h1>

        <p className="mt-3 text-center text-sm text-muted-foreground">
          Last updated{" "}
          <time dateTime={PUBLIC_PAGE_LAST_MODIFIED.privacy}>
            {formatPublicPageDate(PUBLIC_PAGE_LAST_MODIFIED.privacy)}
          </time>
        </p>

        <div className="mt-8 space-y-7 text-base leading-relaxed text-card-foreground sm:text-lg">
          <p>
            This Privacy Policy explains how HackerAI LLC (&quot;HackerAI,&quot;
            &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) handles personal
            information when you use our websites, applications, and related
            services (the &quot;Service&quot;).
          </p>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              Information we collect
            </h2>
            <p>
              Depending on how you use the Service, we collect information you
              provide, information generated through your use, and limited
              information from service providers. This may include account and
              billing information; prompts, messages, files, security findings,
              and other content you submit; agent, browser, and sandbox
              activity; device, usage, referral, and diagnostic data; and
              communications with us. Please avoid submitting personal
              information that is not needed for your use of the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              How we use information
            </h2>
            <p>
              We use information to provide and personalize the Service, process
              payments, authenticate accounts, operate AI and security features,
              respond to requests, maintain safety and reliability, prevent
              misuse, understand and improve the Service, and comply with legal
              obligations.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              Cookies and analytics
            </h2>
            <p>
              We use essential cookies and similar technologies for core
              functions such as authentication, security, and requested
              redirects. We may also use optional storage and analytics for
              attribution, product usage, error diagnostics, and, on eligible
              accounts, session replay. Analytics may include account, device,
              subscription, session, usage, and diagnostic information.
            </p>
            <p className="mt-2">
              Where consent is required, optional browser analytics and
              attribution remain off unless you allow them, and session replay
              remains off. Declining optional analytics does not limit the
              Service. You can later change a saved choice through{" "}
              <strong>Cookie settings</strong>. Limited operational logs may
              still be processed as needed to secure, operate, support, and bill
              for the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              How we disclose information
            </h2>
            <p>
              We disclose information as reasonably necessary to service
              providers that support hosting, storage, authentication, billing,
              analytics, customer support, AI model processing, search, content
              retrieval, and agent execution. Content sent to an AI feature may
              be processed by the provider supporting the selected model or
              tool. We may also disclose information at your direction, to
              protect users or the Service, in connection with a corporate
              transaction, or when required by law. We do not currently sell
              personal information. Any future commercial data contribution
              program would require the separate choices described below.
            </p>
            <p className="mt-2">
              Our{" "}
              <Link href="/trust" className={linkClassName}>
                Security &amp; Trust page
              </Link>{" "}
              provides more information about the services we rely on and the
              data they process.
            </p>
          </section>

          <section id="data-contributions">
            <h2 className="mb-2 text-xl font-semibold">
              Model improvement and data licensing
            </h2>
            <p>
              We may introduce a program to use eligible future task content,
              such as prompts, responses, files, and tool results, to train and
              evaluate AI models. This may include licensing content to AI
              partners for compensation. Partner data collection is not active.
              We will provide program details before it starts and obtain any
              required consent or agreement.
            </p>
            <p className="mt-2">
              Improve the model for everyone is on by default in Settings &gt;
              Data controls. You can turn it off anytime; your choice is saved
              to your account. Turning it off excludes your content from future
              program collection and new transfers without changing your plan or
              the processing needed to answer your requests. Historical content
              and tasks created while the setting was off remain excluded, even
              if you later turn it back on.
            </p>
            <p className="mt-2">
              Participation is subject to applicable law and the rights needed
              to license the content. An enabled setting does not replace any
              required consent. Before collection, we will explain the content
              included, recipients, uses, retention, and applicable privacy
              choices, including how withdrawal or deletion affects content
              already shared. Your applicable privacy rights remain in effect.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              Legal bases for processing
            </h2>
            <p>
              Where applicable law requires a legal basis, we process personal
              information as needed to provide the Service and perform our
              agreement with you; for legitimate interests such as securing,
              supporting, and improving the Service; with your consent; and to
              comply with legal obligations. We consider the nature of the
              information and your rights when relying on legitimate interests.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              Retention and international processing
            </h2>
            <p>
              We retain personal information for as long as reasonably needed
              for the purposes described here, including to provide the Service,
              maintain security and business records, resolve disputes, and meet
              legal obligations. Retention varies by the type of information and
              may continue for a limited period in backups and logs. Information
              may be processed in the United States and other countries where we
              or our service providers operate, subject to applicable legal
              requirements.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              Your choices and rights
            </h2>
            <p>
              Depending on where you live, you may have rights to access,
              correct, delete, restrict, object to, or receive a copy of certain
              personal information, withdraw consent, or appeal a decision about
              a request. You may also have the right to complain to your local
              data protection authority. Some information can be managed or
              deleted through your account settings. To make another privacy
              request, contact us as described below. We may need to verify your
              identity and may retain information where permitted or required by
              law.
            </p>
            <p className="mt-2">
              Browser &quot;Do Not Track&quot; signals are not standardized, and
              the Service does not currently respond to them. You can use
              available browser controls and HackerAI&apos;s Cookie settings to
              manage optional browser storage where offered.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">Security</h2>
            <p>
              We use reasonable administrative, technical, and organizational
              measures designed to protect personal information. No system is
              completely secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">Children</h2>
            <p>
              The Service is not directed to children under 13, and we do not
              knowingly collect personal information from them. If you believe a
              child under 13 has provided personal information, please contact
              us so we can review and address it.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">Policy changes</h2>
            <p>
              We may update this policy as the Service or applicable
              requirements change. We will post the updated policy here and
              revise the date above. When appropriate, we may provide additional
              notice through the Service or another reasonable channel. Policy
              updates do not override your opt-out. We will provide additional
              notice and obtain consent where required by law.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">Contact us</h2>
            <p>
              HackerAI LLC is responsible for the personal information described
              in this policy. For privacy questions or requests, contact us
              through our{" "}
              <a
                href="https://help.hackerai.co/en/"
                target="_blank"
                rel="noopener noreferrer"
                className={linkClassName}
              >
                help center
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
