"use client";

import React, { useState } from "react";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Button } from "@/components/ui/button";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Loader2 } from "lucide-react";

interface HeaderProps {
  chatTitle?: string;
}

const Header: React.FC<HeaderProps> = ({ chatTitle }) => {
  const { user, loading } = useAuth();
  const [navigating, setNavigating] = useState<"signin" | "signup" | null>(null);

  const handleSignIn = () => {
    setNavigating("signin");
    window.location.href = "/login";
  };

  const handleSignUp = () => {
    setNavigating("signup");
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
                disabled={navigating !== null}
                variant="default"
                size="default"
                className="min-w-[74px] rounded-[10px]"
              >
                {navigating === "signin" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Sign in"
                )}
              </Button>
              <Button
                data-testid="sign-up-button"
                onClick={handleSignUp}
                disabled={navigating !== null}
                variant="outline"
                size="default"
                className="min-w-16 rounded-[10px]"
              >
                {navigating === "signup" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Sign up"
                )}
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
              disabled={navigating !== null}
              variant="default"
              size="sm"
              className="rounded-[10px]"
            >
              {navigating === "signin" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Sign in"
              )}
            </Button>
            <Button
              data-testid="sign-up-button-mobile"
              onClick={handleSignUp}
              disabled={navigating !== null}
              variant="outline"
              size="sm"
              className="rounded-[10px]"
            >
              {navigating === "signup" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Sign up"
              )}
            </Button>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
