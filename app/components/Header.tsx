"use client";

import React from "react";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Button } from "@/components/ui/button";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

const Header: React.FC = () => {
  const { user, loading } = useAuth();

  const handleSignIn = () => {
    window.location.href = "/login";
  };

  const handleSignUp = () => {
    window.location.href = "/signup";
  };

  const handleSignOut = async () => {
    window.location.href = "/logout";
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
          <div className="flex gap-[40px]"></div>
          {!loading && (
            <div className="flex gap-2 items-center">
              {user ? (
                <Button
                  onClick={handleSignOut}
                  variant="outline"
                  size="default"
                  className="min-w-[74px] rounded-[10px]"
                >
                  Sign out
                </Button>
              ) : (
                <>
                  <Button
                    onClick={handleSignIn}
                    variant="default"
                    size="default"
                    className="min-w-[74px] rounded-[10px]"
                  >
                    Sign in
                  </Button>
                  <Button
                    onClick={handleSignUp}
                    variant="outline"
                    size="default"
                    className="min-w-16 rounded-[10px]"
                  >
                    Sign up
                  </Button>
                </>
              )}
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
        {!loading && (
          <div className="flex items-center gap-2">
            {user ? (
              <Button
                onClick={handleSignOut}
                variant="outline"
                size="sm"
                className="rounded-[10px]"
              >
                Sign out
              </Button>
            ) : (
              <>
                <Button
                  onClick={handleSignIn}
                  variant="default"
                  size="sm"
                  className="rounded-[10px]"
                >
                  Sign in
                </Button>
                <Button
                  onClick={handleSignUp}
                  variant="outline"
                  size="sm"
                  className="rounded-[10px]"
                >
                  Sign up
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
