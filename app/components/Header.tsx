"use client";

import React from "react";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Button } from "@/components/ui/button";
import { useAppAuth } from "../hooks/useAppAuth";
import { isWorkOSEnabled } from "@/lib/auth/client";

const Header: React.FC = () => {
  const { user, loading } = useAppAuth();

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
    <header className="w-full py-[10px] flex gap-10 px-6 max-md:hidden max-sm:px-4">
      <div className="flex items-center gap-2">
        <HackerAISVG theme="dark" scale={0.15} />
        <span className="text-foreground text-xl font-semibold">HackerAI</span>
      </div>
      <div className="flex flex-1 gap-2 justify-between items-center">
        <div className="flex gap-[40px]"></div>
        {/* Only show auth buttons when WorkOS auth is enabled */}
        {isWorkOSEnabled() && !loading && (
          <div className="flex gap-2 items-center">
            {user ? (
              // Show sign out button when user is authenticated
              <Button
                onClick={handleSignOut}
                variant="outline"
                size="default"
                className="min-w-[74px] rounded-[10px]"
              >
                Sign out
              </Button>
            ) : (
              // Show sign in/up buttons when user is not authenticated
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
    </header>
  );
};

export default Header;
