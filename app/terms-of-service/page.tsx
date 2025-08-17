import type { Metadata } from "next";

export const metadata: Metadata = {
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

export default function TermsOfServicePage() {
  return (
    <div className="px-4 py-8 pb-16 md:px-0">
      <div className="container mx-auto max-w-2xl space-y-6 rounded-md border bg-card px-4 py-8 shadow-lg sm:px-8">
        <h1 className="mb-5 text-center text-3xl font-semibold text-card-foreground">
          HackerAI Terms of Service
        </h1>

        <div className="mt-4 text-lg leading-relaxed text-card-foreground">
          <ol className="list-inside list-decimal">
            <li className="mb-3">
              <strong>Lawful Use:</strong> Users of products, services, or
              software (&quot;Products&quot;) provided by HackerAI LLC
              (&quot;the Company&quot;) agree to use the Products only for
              lawful purposes and in accordance with all applicable laws,
              regulations, and guidelines.
            </li>
            <li className="mb-3">
              <strong>Limitation of Liability:</strong> Neither HackerAI LLC,
              nor its parent companies, affiliates, directors, officers,
              employees, agents, partners, or licensors shall be held
              responsible or liable, directly or indirectly, for any damages,
              losses, or consequences, whether incidental, consequential,
              direct, indirect, special, punitive, or otherwise, arising out of
              or in connection with any use or misuse of the Products, whether
              such use is lawful or unlawful.
            </li>
            <li className="mb-3">
              <strong>No Endorsement of User Content:</strong> The Company does
              not endorse, support, represent, or guarantee the completeness,
              accuracy, reliability, or suitability of any content or
              communications made available through its Products, nor does it
              endorse any opinions expressed by users of its Products.
            </li>
            <li className="mb-3">
              <strong>User Responsibility and Indemnity:</strong> The user
              assumes full responsibility for any risks associated with their
              use of the Products. The user agrees to indemnify and hold
              harmless HackerAI LLC, its parent companies, and their respective
              officers, directors, employees, and agents from and against any
              claims, actions, or demands, including without limitation
              reasonable legal and accounting fees, arising or resulting from
              their use of the Products or their breach of these Terms of
              Service. This indemnity includes any liability or expense arising
              from claims, losses, damages, judgments, fines, litigation costs,
              and legal fees.
            </li>
            <li className="mb-3">
              <strong>Changes to Terms of Service:</strong> HackerAI LLC
              reserves the right to update or modify these Terms of Service at
              any time without prior notice. Your use of the Products after any
              such changes constitutes your acceptance of the new terms. It is
              your responsibility to review the Terms of Service periodically
              for changes.
            </li>
            <li className="mb-3">
              <strong>Severability:</strong> If any provision of these Terms of
              Service is found by a court of competent jurisdiction to be
              invalid, the parties nevertheless agree that the court should
              endeavor to give effect to the parties&apos; intentions as
              reflected in the provision, and the other provisions of the Terms
              of Service remain in full force and effect.
            </li>
          </ol>

          <p className="mt-4">
            By using the Products provided by HackerAI LLC, you indicate your
            understanding and agreement to abide by the terms and conditions set
            forth in these Terms of Service. If you do not agree with these
            terms, please refrain from using the Products.
          </p>
        </div>
      </div>
    </div>
  );
}
