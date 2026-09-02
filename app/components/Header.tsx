"use client";

import React from "react";
import Link from "next/link";
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
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { navigateToAuth } from "@/app/hooks/useTauri";
import { Download, Menu } from "lucide-react";

const publicNavigation = [
  { href: "/product", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/download", label: "Download" },
  { href: "/trust", label: "Trust" },
] as const;

interface HeaderProps {
  chatTitle?: string;
  hideDownload?: boolean;
}

const Header: React.FC<HeaderProps> = ({ chatTitle, hideDownload = false }) => {
  const { user, loading } = useAuth();

  return (
    <header className="w-full px-6 max-sm:px-4 flex-shrink-0">
      {/* Desktop header */}
      <div className="py-[10px] flex gap-10 items-center justify-between max-md:hidden">
        <div className="flex items-center gap-2">
          <HackerAISVG theme="dark" scale={0.15} />
          <span className="text-foreground text-xl font-semibold">
            HackerAI
          </span>
        </div>
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
              {publicNavigation.map((item) =>
                item.href !== "/download" ? (
                  <Button key={item.href} asChild variant="ghost" size="sm">
                    <Link href={item.href}>{item.label}</Link>
                  </Button>
                ) : null,
              )}
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
        <div className="flex items-center gap-2">
          <HackerAISVG theme="dark" scale={0.12} />
          <span className="text-foreground text-lg font-semibold">
            HackerAI
          </span>
        </div>
        {!loading && !user && (
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
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-mr-2"
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
                  {publicNavigation.map((item) =>
                    item.href === "/download" && hideDownload ? null : (
                      <SheetClose key={item.href} asChild>
                        <Link
                          href={item.href}
                          className="rounded-md px-3 py-3 text-base font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {item.label}
                        </Link>
                      </SheetClose>
                    ),
                  )}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
