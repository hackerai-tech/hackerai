import Link from "next/link";
import { ArrowRight, Menu } from "lucide-react";

import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

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

          <Sheet>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="md:hidden"
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
                {navigation.map((item) => (
                  <SheetClose key={item.href} asChild>
                    <Link
                      href={item.href}
                      className="rounded-md px-3 py-3 text-base font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {item.label}
                    </Link>
                  </SheetClose>
                ))}
              </nav>
              <SheetFooter className="mt-0 grid grid-cols-2 gap-2 border-t border-border p-4">
                <SheetClose asChild>
                  <Link
                    href="/login"
                    prefetch={false}
                    className={buttonVariants({ variant: "outline" })}
                  >
                    Sign in
                  </Link>
                </SheetClose>
                <SheetClose asChild>
                  <Link href="/signup" className={buttonVariants()}>
                    Get started
                    <ArrowRight className="size-4" />
                  </Link>
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
