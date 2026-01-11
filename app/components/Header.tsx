"use client";

import React from "react";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Button } from "@/components/ui/button";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useTauri, openInBrowser } from "@/app/hooks/useTauri";

interface HeaderProps {
  chatTitle?: string;
}

const Header: React.FC<HeaderProps> = ({ chatTitle }) => {
  const { user, loading } = useAuth();
  const { isTauri } = useTauri();

  const handleSignIn = async () => {
    if (isTauri) {
      try {
        const opened = await openInBrowser(
          `${window.location.origin}/desktop-login`,
        );
        if (opened) return;
      } catch {
        // Fall through to web navigation
      }
    }
    window.location.href = "/login";
  };

  const handleSignUp = async () => {
    if (isTauri) {
      try {
        const opened = await openInBrowser(
          `${window.location.origin}/desktop-login`,
        );
        if (opened) return;
      } catch {
        // Fall through to web navigation
      }
    }
    window.location.href = "/signup";
  };

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
          {!chatTitle && <div className="flex gap-[40px]"></div>}
          {!loading && !user && (
            <div className="flex gap-2 items-center">
              <Button
                data-testid="sign-in-button"
                onClick={handleSignIn}
                variant="default"
                size="default"
                className="min-w-[74px] rounded-[10px]"
              >
                Sign in
              </Button>
              <Button
                data-testid="sign-up-button"
                onClick={handleSignUp}
                variant="outline"
                size="default"
                className="min-w-16 rounded-[10px]"
              >
                Sign up
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
              onClick={handleSignIn}
              variant="default"
              size="sm"
              className="rounded-[10px]"
            >
              Sign in
            </Button>
            <Button
              data-testid="sign-up-button-mobile"
              onClick={handleSignUp}
              variant="outline"
              size="sm"
              className="rounded-[10px]"
            >
              Sign up
            </Button>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
