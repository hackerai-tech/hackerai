"use client";

import React from "react";
import Link from "next/link";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { navigateToAuth } from "@/app/hooks/useTauri";
import {
  CreditCard,
  Download,
  LayoutGrid,
  Menu,
  ShieldCheck,
  X,
} from "lucide-react";

const publicNavigation = [
  { href: "/product", label: "Product", icon: LayoutGrid },
  { href: "/pricing", label: "Pricing", icon: CreditCard },
  { href: "/download", label: "Download", icon: Download },
  { href: "/trust", label: "Trust", icon: ShieldCheck },
] as const;

export type PublicNavigationPath = (typeof publicNavigation)[number]["href"];

interface HeaderProps {
  chatTitle?: string;
  hideDownload?: boolean;
  /** Path of the public page rendering the header, used to mark the current link. */
  currentPath?: PublicNavigationPath;
}

const Header: React.FC<HeaderProps> = ({
  chatTitle,
  hideDownload = false,
  currentPath,
}) => {
  const { user, loading } = useAuth();

  return (
    <header className="w-full px-6 max-sm:px-4 flex-shrink-0">
      {/* Desktop header */}
      <div className="py-[10px] flex gap-10 items-center justify-between max-md:hidden">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label="HackerAI home"
        >
          <HackerAISVG theme="dark" scale={0.15} />
          <span className="text-foreground text-xl font-semibold">
            HackerAI
          </span>
        </Link>
        <div className="flex flex-1 gap-2 justify-between items-center">
          {chatTitle && (
            <div className="flex-1 text-center">
              <span className="text-foreground text-lg font-medium truncate">
                {chatTitle}
              </span>
            </div>
          )}
          {!chatTitle && (
            <nav className="flex items-center gap-1" aria-label="Primary">
              {publicNavigation.map((item) => {
                if (item.href === "/download") return null;
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
          )}
          {!loading && !user && (
            <div className="flex gap-2 items-center">
              {!hideDownload && (
                <Button
                  asChild
                  variant="ghost"
                  size="default"
                  className="rounded-[10px]"
                >
                  <Link href="/download">
                    <Download className="h-4 w-4 mr-1.5" />
                    Download
                  </Link>
                </Button>
              )}
              <Button
                data-testid="sign-in-button"
                onClick={() => navigateToAuth("/login")}
                variant="default"
                size="default"
                className="min-w-[74px] rounded-[10px]"
              >
                Sign in
              </Button>
              <Button
                data-testid="sign-up-button"
                onClick={() =>
                  navigateToAuth("/signup", {
                    preferSignInForReturningUser: true,
                  })
                }
                variant="outline"
                size="default"
                className="min-w-16 rounded-[10px]"
              >
                Get started
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Mobile header */}
      <div className="py-3 flex items-center justify-between md:hidden">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label="HackerAI home"
        >
          <HackerAISVG theme="dark" scale={0.12} />
          <span className="text-foreground text-lg font-semibold">
            HackerAI
          </span>
        </Link>
        {!loading && !user && (
          <Sheet>
            <div className="flex items-center gap-2">
              <Button
                data-testid="sign-in-button-mobile"
                onClick={() => navigateToAuth("/login")}
                variant="default"
                size="sm"
                className="rounded-[10px]"
              >
                Sign in
              </Button>
              <Button
                data-testid="sign-up-button-mobile"
                onClick={() =>
                  navigateToAuth("/signup", {
                    preferSignInForReturningUser: true,
                  })
                }
                variant="outline"
                size="sm"
                className="rounded-[10px]"
              >
                Get started
              </Button>
              <SheetTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-mr-2 size-10"
                  aria-label="Open navigation"
                >
                  <Menu className="size-6" />
                </Button>
              </SheetTrigger>
            </div>
            {/* Full-screen menu that repeats the header row so the page chrome never changes. */}
            <SheetContent
              side="top"
              className="h-dvh gap-0 border-0 p-0 [&>button:last-child]:hidden"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex items-center justify-between px-6 py-3 max-sm:px-4">
                <SheetClose asChild>
                  <Link
                    href="/"
                    className="flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label="HackerAI home"
                  >
                    <HackerAISVG theme="dark" scale={0.12} />
                    <span className="text-foreground text-lg font-semibold">
                      HackerAI
                    </span>
                  </Link>
                </SheetClose>
                <div className="flex items-center gap-2">
                  <Button
                    data-testid="sign-in-button-menu"
                    onClick={() => navigateToAuth("/login")}
                    variant="default"
                    size="sm"
                    className="rounded-[10px]"
                  >
                    Sign in
                  </Button>
                  <Button
                    data-testid="sign-up-button-menu"
                    onClick={() =>
                      navigateToAuth("/signup", {
                        preferSignInForReturningUser: true,
                      })
                    }
                    variant="outline"
                    size="sm"
                    className="rounded-[10px]"
                  >
                    Get started
                  </Button>
                  <SheetClose asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="-mr-2 size-10"
                      aria-label="Close navigation"
                    >
                      <X className="size-6" />
                    </Button>
                  </SheetClose>
                </div>
              </div>
              <nav className="px-6 py-4 max-sm:px-4" aria-label="Mobile">
                <p className="text-xl font-semibold">Explore</p>
                <ul className="mt-3">
                  {publicNavigation.map((item) => {
                    if (item.href === "/download" && hideDownload) return null;
                    const isCurrent = item.href === currentPath;
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <SheetClose asChild>
                          <Link
                            href={item.href}
                            aria-current={isCurrent ? "page" : undefined}
                            className={cn(
                              "flex items-center gap-4 rounded-lg py-3 text-lg font-medium text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                            )}
                          >
                            <span
                              className={cn(
                                "flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted",
                                isCurrent && "bg-accent",
                              )}
                            >
                              <Icon className="size-5" aria-hidden="true" />
                            </span>
                            {item.label}
                          </Link>
                        </SheetClose>
                      </li>
                    );
                  })}
                </ul>
              </nav>
            </SheetContent>
          </Sheet>
        )}
      </div>
    </header>
  );
};

export default Header;
