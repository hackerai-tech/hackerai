import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { withAuth } from "@workos-inc/authkit-nextjs";
import Header from "@/app/components/Header";
import { isAbuseOperator } from "@/lib/abuse/operator";
import OperatorReview from "./OperatorReview";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Restricted review | HackerAI",
  robots: { index: false, follow: false },
};
export default async function AbuseOperationsPage() {
  const { user } = await withAuth();
  if (!isAbuseOperator(user?.id)) notFound();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="mx-auto max-w-[880px] px-5 pb-24 pt-28 sm:px-8">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          Restricted access
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          Restricted review
        </h1>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          Every case open and action is recorded with your operator identity.
          Report contents stay out of product analytics.
        </p>
        <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
          Operator: {user!.id}
        </p>
        <OperatorReview />
      </main>
    </div>
  );
}
