import type { Metadata } from "next";
import Link from "next/link";

import { canonicalMetadata } from "@/lib/seo/site";
import { PentestExample } from "@/components/public/PentestExample";
import HomePageClient from "./HomePageClient";

export const metadata: Metadata = {
  ...canonicalMetadata("/"),
};

export default function Page() {
  return (
    <HomePageClient>
      <section
        className="border-t border-border/80 px-6 py-16 sm:py-24"
        aria-labelledby="pentesting-overview"
      >
        <div className="mx-auto max-w-5xl">
          <div className="max-w-2xl">
            <h2
              id="pentesting-overview"
              className="text-3xl font-medium tracking-tight sm:text-4xl"
            >
              AI for penetration testing, from question to evidence.
            </h2>
            <p className="mt-4 text-lg leading-8 text-muted-foreground">
              Use HackerAI to investigate an application you have permission to
              test. Bring your scope, test accounts, and source files. Ask for
              focused analysis, or use Agent mode to run terminal and browser
              tools in a connected local environment or a cloud sandbox.
            </p>
            <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-sm font-medium">
              <Link
                href="/product"
                className="rounded-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Explore the penetration testing workflow
              </Link>
              <Link
                href="/pricing"
                className="rounded-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Compare plans and usage limits
              </Link>
            </div>
          </div>
          <div className="mt-12">
            <PentestExample />
          </div>
        </div>
      </section>
    </HomePageClient>
  );
}
