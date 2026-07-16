"use client";

import React from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { PUBLIC_POSITIONING } from "@/lib/marketing/positioning";

const Footer: React.FC = () => {
  const { user, loading } = useAuth();

  if (loading || user) {
    return null;
  }

  return (
    <div className="text-muted-foreground relative flex min-h-8 w-full flex-shrink-0 items-center justify-center p-4 text-center text-xs md:px-[60px]">
      <div className="flex max-w-4xl flex-col items-center gap-1.5 text-sm leading-relaxed">
        <p className="text-pretty">{PUBLIC_POSITIONING.footerBoundary}</p>
        <p>
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
          . <span className="text-muted-foreground">&middot;</span>{" "}
          <a
            href="/trust"
            target="_blank"
            className="text-foreground underline decoration-foreground"
            rel="noreferrer"
          >
            Security &amp; Trust
          </a>
        </p>
      </div>
    </div>
  );
};

export default Footer;
