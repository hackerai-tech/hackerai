"use client";

import { ReactNode, useState } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuth } from "convex/react";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { useAuthFromAuthKit } from "@/lib/auth/use-auth-from-authkit";

const noop = () => {};
const PRERENDER_CONVEX_URL = "https://placeholder.convex.cloud";

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const [convex] = useState(() => {
    const convexUrl =
      process.env.NEXT_PUBLIC_CONVEX_URL ??
      (typeof window === "undefined" ? PRERENDER_CONVEX_URL : undefined);

    if (!convexUrl) {
      throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
    }

    return new ConvexReactClient(convexUrl);
  });

  return (
    // Prevent AuthKit's default window.location.reload() on session expiration.
    // We handle auth state gracefully via Convex token refresh and middleware checks.
    <AuthKitProvider onSessionExpired={noop}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
        {children}
      </ConvexProviderWithAuth>
    </AuthKitProvider>
  );
}
