import Link from "next/link";
import { ArrowRight, Menu } from "lucide-react";

import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/product", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/download", label: "Download" },
  { href: "/trust", label: "Trust" },
] as const;

export type PublicSitePath = (typeof navigation)[number]["href"];

interface PublicSiteHeaderProps {
  /** Path of the page rendering the header, used to mark the current link. */
  currentPath?: PublicSitePath;
}

export function PublicSiteHeader({ currentPath }: PublicSiteHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
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
          {navigation.map((item) => {
            const isCurrent = item.href === currentPath;
            return (
              <Button
                key={item.href}
                asChild
                variant="ghost"
                size="sm"
                className={cn(
                  isCurrent
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Link
                  href={item.href}
                  aria-current={isCurrent ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </Button>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="hidden md:flex">
            <Link href="/login" prefetch={false}>
              Sign in
            </Link>
          </Button>
          <Button asChild size="sm" className="hidden md:inline-flex">
            <Link href="/signup">
              Get started
              <ArrowRight className="size-4" />
            </Link>
          </Button>

          {/* Small screens keep both auth actions visible; the sheet only holds navigation. */}
          <Button asChild size="sm" className="md:hidden">
            <Link href="/login" prefetch={false}>
              Sign in
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="md:hidden">
            <Link href="/signup">Get started</Link>
          </Button>

          <Sheet>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-mr-2 md:hidden"
                aria-label="Open navigation"
              >
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="w-full gap-0 border-border p-0 sm:max-w-sm"
            >
              <SheetHeader className="border-b border-border px-5 py-5">
                <SheetTitle>HackerAI</SheetTitle>
              </SheetHeader>
              <nav
                className="flex flex-col gap-1 px-3 py-4"
                aria-label="Mobile"
              >
                {navigation.map((item) => {
                  const isCurrent = item.href === currentPath;
                  return (
                    <SheetClose key={item.href} asChild>
                      <Link
                        href={item.href}
                        aria-current={isCurrent ? "page" : undefined}
                        className={cn(
                          "rounded-md px-3 py-3 text-base font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          isCurrent
                            ? "bg-accent text-foreground"
                            : "text-foreground",
                        )}
                      >
                        {item.label}
                      </Link>
                    </SheetClose>
                  );
                })}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
