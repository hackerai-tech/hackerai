"use client";

import React from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

const Footer: React.FC = () => {
  const { user, loading } = useAuth();

  if (loading || user) {
    return null;
  }

  return (
    <div className="text-muted-foreground relative flex min-h-8 w-full items-center justify-center p-4 text-center text-xs md:px-[60px] flex-shrink-0">
      <span className="text-sm leading-none">
        By messaging HackerAI, you agree to our{" "}
        <a
          href="/terms-of-service"
          target="_blank"
          className="text-foreground underline decoration-foreground"
          rel="noreferrer"
        >
          Terms
        </a>{" "}
        and have read our{" "}
        <a
          href="/privacy-policy"
          target="_blank"
          className="text-foreground underline decoration-foreground"
          rel="noreferrer"
        >
          Privacy Policy
        </a>
        .
      </span>
    </div>
  );
};

export default Footer;
