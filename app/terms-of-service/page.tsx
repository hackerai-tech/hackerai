import type { Metadata } from "next";
import Link from "next/link";
import {
  HELP_CENTER_URL,
  PUBLIC_PAGE_LAST_MODIFIED,
  REFUND_HELP_URL,
  canonicalMetadata,
  formatPublicPageDate,
} from "@/lib/seo/site";

export const metadata: Metadata = {
  ...canonicalMetadata("/terms-of-service"),
  title: "Terms of Service | HackerAI",
  description: "Terms of Service and conditions for HackerAI services.",
  openGraph: {
    title: "Terms of Service | HackerAI",
    description: "Terms of Service and conditions for HackerAI services.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Terms of Service | HackerAI",
    description: "Terms of Service and conditions for HackerAI services.",
  },
};

export const dynamic = "force-static";

const linkClassName =
  "font-medium text-foreground underline underline-offset-4 hover:text-foreground/80";

export default function TermsOfServicePage() {
  return (
    <div className="px-4 py-8 pb-16 md:px-0">
      <main className="container mx-auto max-w-2xl rounded-md border bg-card px-4 py-8 shadow-lg sm:px-8">
        <h1 className="text-center text-3xl font-semibold text-card-foreground">
          HackerAI Terms of Service
        </h1>

        <p className="mt-3 text-center text-sm text-muted-foreground">
          Last updated{" "}
          <time dateTime={PUBLIC_PAGE_LAST_MODIFIED.terms}>
            {formatPublicPageDate(PUBLIC_PAGE_LAST_MODIFIED.terms)}
          </time>
        </p>

        <div className="mt-8 space-y-7 text-base leading-relaxed text-card-foreground sm:text-lg">
          <p>
            These Terms of Service (the &quot;Terms&quot;) are an agreement
            between you and HackerAI LLC (&quot;HackerAI,&quot; &quot;we,&quot;
            &quot;us,&quot; or &quot;our&quot;) governing your use of our
            websites, applications, desktop and command-line software, agents,
            and related services (together, the &quot;Service&quot;). By
            creating an account, clicking to accept, or using the Service, you
            agree to these Terms and to our{" "}
            <Link href="/privacy-policy" className={linkClassName}>
              Privacy Policy
            </Link>
            . If you do not agree, do not use the Service. If you use the
            Service on behalf of an organization, you represent that you have
            authority to bind that organization, and &quot;you&quot; includes
            it.
          </p>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              1. Eligibility and accounts
            </h2>
            <p>
              You must be at least 18 years old, or the age of majority where
              you live, and legally able to enter this agreement. You must
              provide accurate information, keep it current, and keep your
              credentials confidential. You are responsible for all activity
              under your account, whether or not you authorized it. You may
              maintain only one account unless we agree otherwise. Team accounts
              are controlled by the team administrator, who may add, remove, and
              manage members and may access content created within the team.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              2. Authorized security testing and acceptable use
            </h2>
            <p>
              The Service is a security research and penetration testing tool.
              You may use it only on systems, networks, applications, and data
              that you own or for which you hold explicit, current, and
              sufficient written authorization from the owner, and only within
              the scope of that authorization. You are solely responsible for
              obtaining, documenting, and complying with such authorization and
              with all laws that apply to you, including computer misuse, data
              protection, export, and privacy laws in every relevant
              jurisdiction.
            </p>
            <p className="mt-2">
              You must not use the Service to access, disrupt, damage, or
              exfiltrate data from any system without authorization; to develop
              or deploy malicious software against third parties; to harm,
              harass, or defraud any person; to violate the rights of others; to
              circumvent security, rate limits, quotas, or safety measures of
              the Service; to reverse engineer or scrape the Service; or to
              resell or provide the Service to third parties without our
              permission. We may, but are not obligated to, monitor, moderate,
              restrict, or refuse any use or content that we believe violates
              these Terms, applicable law, or the policies of our providers.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              3. AI features, agents, and execution environments
            </h2>
            <p>
              The Service uses artificial intelligence models and automated
              agents that may generate text, plan actions, run commands, browse
              the web, and process files at your direction. AI output and agent
              actions can be inaccurate, incomplete, outdated, or inappropriate,
              and may fail or behave unexpectedly. You are responsible for
              reviewing, validating, and deciding whether to act on any output
              or finding, and for every action taken by an agent on your behalf.
              Nothing in the Service is professional, legal, or security advice,
              and it does not guarantee that any system is secure or that any
              vulnerability exists or has been fixed.
            </p>
            <p className="mt-2">
              By default, agent commands run in cloud sandboxes that we may
              reset, suspend, or delete at any time. If you enable local
              execution through our desktop or command-line software, commands
              run directly on your device with the privileges of your user
              account and without isolation. You accept all risk of local
              execution, including data loss or damage to your systems, and
              should use it only on devices dedicated to testing with
              appropriate backups.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">4. Your content</h2>
            <p>
              You retain ownership of the prompts, files, findings, and other
              material you submit (&quot;Input&quot;) and, as between you and
              us, of the output the Service generates for you
              (&quot;Output&quot;). You grant us a worldwide, non-exclusive,
              royalty-free license to host, process, transmit, store, reproduce,
              and display Input and Output as needed to provide, secure,
              support, and improve the Service and to comply with law. You
              represent that you have all rights needed to submit your Input and
              that it does not violate law or third-party rights.
            </p>
            <p className="mt-2">
              Input and Output may be processed by third-party model, search,
              and infrastructure providers under their own terms, as described
              on our{" "}
              <Link href="/trust" className={linkClassName}>
                Security &amp; Trust page
              </Link>
              , and we do not control or guarantee the practices of those
              providers, including whether they use data for training. Output
              may not be unique, and similar Output may be provided to other
              users. If you create a shared link, the shared content becomes
              accessible to anyone with the link and may be viewed, copied, or
              indexed. Any feedback or suggestions you provide may be used by us
              without restriction or compensation.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              5. Plans, billing, and payments
            </h2>
            <p>
              Some features require a paid plan, seats, or usage credits.
              Prices, included usage, limits, and features are described in the
              Service and may change. Subscriptions renew automatically at the
              then-current price for the same term until cancelled. You
              authorize us and our payment processor to charge your payment
              method for recurring fees, seat changes, usage purchases,
              automatic reloads you enable, and applicable taxes. You may cancel
              at any time through your account settings, and cancellation takes
              effect at the end of the current billing period.
            </p>
            <p className="mt-2">
              Except where required by law or as described in our{" "}
              <a
                href={REFUND_HELP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClassName}
              >
                refund guidelines
              </a>
              , all payments are final and non-refundable, and we do not provide
              refunds or credits for partial periods, unused usage, downgrades,
              or unused seats. Usage credits and balances have no cash value,
              are non-transferable, may expire, and are forfeited when your
              account is closed. Plan changes may be prorated. If a payment
              fails or is disputed, we may suspend or downgrade your account
              until the balance is paid. We may change prices or plans with
              reasonable notice, and continued use after the change takes effect
              constitutes acceptance. We may offer trials, promotions,
              discounts, or experimental pricing on any terms we choose and may
              modify or withdraw them at any time.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              6. Referral program and promotional credits
            </h2>
            <p>
              We may offer referral rewards, sign-up bonuses, or other
              promotional credits. Eligibility, amounts, and conditions are
              described in the Service and may change at any time. Rewards and
              credits have no cash value, are non-transferable, and may be
              limited, delayed, withheld, reversed, or revoked at our
              discretion, including where we suspect self-referral, duplicate or
              disposable accounts, spam, or other abuse. We may modify, pause,
              or end any program at any time without liability.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              7. Usage limits and abuse controls
            </h2>
            <p>
              Usage limits, starter bonuses, referrals, and similar eligibility
              controls may be tied to privacy-preserving account identity
              signals. Deleting and recreating an account does not reset usage
              limits or referral eligibility, and you may not circumvent rate
              limits, quotas, or protective measures. We may adjust limits at
              any time to protect the Service, manage capacity, or respond to
              provider availability.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              8. Suspension and termination
            </h2>
            <p>
              We may suspend, restrict, or terminate your access to all or part
              of the Service at any time, with or without notice, if we believe
              you have violated these Terms or applicable law, if your payment
              is disputed, charged back, or flagged as fraudulent, if required
              by law or a provider, or to protect the Service, our users, or
              third parties. You may stop using the Service or delete your
              account at any time. On termination, your right to use the Service
              ends, we may delete your content and data after a reasonable
              period, and no refund is owed for termination due to your breach.
              Sections that by their nature should survive, including those on
              content, payments, disclaimers, liability, indemnity, and
              disputes, survive termination.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              9. Intellectual property and software
            </h2>
            <p>
              The Service, including its software, models, prompts, design, and
              trademarks, is owned by HackerAI or its licensors and protected by
              intellectual property laws. Subject to these Terms, we grant you a
              limited, revocable, non-exclusive, non-transferable license to
              access and use the Service, and to install and use our desktop and
              command-line software on devices you control, for your internal
              security work. Software we release under an open-source license is
              governed by that license where the two conflict. You may not copy,
              modify, distribute, sell, lease, or create derivative works of the
              Service except as permitted by law or an applicable open-source
              license. All rights not expressly granted are reserved.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              10. Third-party services and links
            </h2>
            <p>
              The Service relies on and may link to third-party services,
              including model providers, hosting, sandboxes, payments, and
              authentication. We are not responsible for third-party services,
              their availability, or their terms, and your use of them may be
              subject to their own agreements.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              11. Disclaimer of warranties
            </h2>
            <p>
              To the maximum extent permitted by law, the Service, all Output,
              and all software are provided &quot;as is&quot; and &quot;as
              available&quot; without warranties of any kind, whether express,
              implied, or statutory, including warranties of merchantability,
              fitness for a particular purpose, title, non-infringement,
              accuracy, and uninterrupted or error-free operation. We do not
              warrant that the Service will meet your requirements, that Output
              will be correct or complete, that any security assessment is
              exhaustive, or that use of the Service will make any system secure
              or compliant with any law or standard.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              12. Limitation of liability
            </h2>
            <p>
              To the maximum extent permitted by law, HackerAI and its
              affiliates, officers, directors, employees, agents, licensors, and
              providers will not be liable for any indirect, incidental,
              special, consequential, exemplary, or punitive damages, or for any
              loss of profits, revenue, data, goodwill, or business, or for the
              cost of substitute services, arising out of or relating to the
              Service or these Terms, however caused and under any theory of
              liability, even if advised of the possibility of such damages.
            </p>
            <p className="mt-2">
              To the maximum extent permitted by law, our total aggregate
              liability for all claims arising out of or relating to the Service
              or these Terms will not exceed the greater of the amounts you paid
              us for the Service in the twelve months before the event giving
              rise to the claim or one hundred U.S. dollars. These limitations
              do not apply to liability that cannot be limited under applicable
              law, and nothing in these Terms limits any statutory rights you
              have as a consumer that cannot be waived.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">13. Indemnity</h2>
            <p>
              To the maximum extent permitted by law, you will defend,
              indemnify, and hold harmless HackerAI and its affiliates,
              officers, directors, employees, agents, and licensors from and
              against any claims, liabilities, damages, losses, fines, and
              expenses, including reasonable legal fees, arising out of or
              relating to your Input, your use of the Service, actions taken by
              agents at your direction, any security testing you conduct, your
              breach of these Terms, or your violation of any law or third-party
              right.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              14. Export controls and sanctions
            </h2>
            <p>
              You may not use or export the Service in violation of applicable
              export control or sanctions laws. You represent that you are not
              located in, organized under, or ordinarily resident in a country
              or territory subject to comprehensive sanctions, and that you are
              not on any restricted-party list.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              15. Changes to the Service and these Terms
            </h2>
            <p>
              We may modify, suspend, or discontinue any part of the Service at
              any time. We may update these Terms from time to time. We will
              post the updated Terms with a new date and, where appropriate or
              required by law, provide additional notice. Changes take effect
              when posted unless we state otherwise. Your continued use after
              the effective date constitutes acceptance, and if you do not agree
              you must stop using the Service.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">
              16. Governing law and disputes
            </h2>
            <p>
              These Terms are governed by the laws of the United States and of
              the state in which HackerAI LLC is organized, without regard to
              conflict-of-law rules, and any dispute will be brought exclusively
              in the state or federal courts located there, except that either
              party may seek injunctive relief in any court of competent
              jurisdiction. Before filing a claim, you agree to contact us and
              attempt in good faith to resolve the dispute informally for at
              least thirty days. To the maximum extent permitted by law, claims
              must be brought in your individual capacity and not as a plaintiff
              or class member in any class or representative action. If you are
              a consumer in a jurisdiction whose mandatory laws give you
              additional rights or a different forum, those rights are not
              affected by this section.
            </p>
          </section>

          <section>
            <h2 className="mb-2 text-xl font-semibold">17. General</h2>
            <p>
              These Terms, together with the Privacy Policy and any
              plan-specific terms presented in the Service, are the entire
              agreement between you and us regarding the Service. If any
              provision is held invalid, it will be enforced to the maximum
              extent permissible and the remaining provisions remain in full
              effect. Our failure to enforce any provision is not a waiver. You
              may not assign these Terms without our consent; we may assign them
              in connection with a merger, acquisition, or sale of assets.
              Nothing in these Terms creates a partnership, agency, or
              employment relationship. Questions about these Terms can be sent
              through our{" "}
              <a
                href={HELP_CENTER_URL}
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
