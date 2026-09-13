"use client";

import React from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  AnalyticsConsentPreferences,
  useAnalyticsConsentPreferencesAvailable,
} from "@/app/components/AnalyticsConsentManager";

const Footer: React.FC = () => {
  const { user, loading } = useAuth();
  const analyticsPreferencesAvailable =
    useAnalyticsConsentPreferencesAvailable();

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
        . <span className="text-muted-foreground">&middot;</span>{" "}
        <a
          href="/trust"
          target="_blank"
          className="text-foreground underline decoration-foreground"
          rel="noreferrer"
        >
          Security &amp; Trust
        </a>
        {analyticsPreferencesAvailable ? (
          <>
            {" "}
            <span className="text-muted-foreground">&middot;</span>{" "}
            <AnalyticsConsentPreferences>
              <button
                type="button"
                className="text-foreground decoration-foreground focus-visible:ring-ring rounded-sm underline focus-visible:ring-2 focus-visible:outline-none"
              >
                Cookie settings
              </button>
            </AnalyticsConsentPreferences>
          </>
        ) : null}
      </span>
    </div>
  );
};

export default Footer;
