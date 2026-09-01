import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Button } from "@/components/ui/button";

const navigation = [
  { href: "/product", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/download", label: "Download" },
  { href: "/trust", label: "Trust" },
] as const;

export function PublicSiteHeader() {
  return (
    <header className="border-b border-border/80 bg-background/95">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label="HackerAI home"
        >
          <HackerAISVG theme="dark" scale={0.13} />
          <span className="text-lg font-semibold text-foreground">
            HackerAI
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {navigation.map((item) => (
            <Button key={item.href} asChild variant="ghost" size="sm">
              <Link href={item.href}>{item.label}</Link>
            </Button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="hidden sm:flex">
            <Link href="/login" prefetch={false}>
              Sign in
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/signup">
              Get started
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
