"use client";

import { ReactNode, useState } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuth } from "convex/react";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import type { NoUserInfo, UserInfo } from "@workos-inc/authkit-nextjs";
import { useAuthFromAuthKit } from "@/lib/auth/use-auth-from-authkit";

const PRERENDER_CONVEX_URL = "https://placeholder.convex.cloud";

type AuthKitInitialAuth =
  Omit<UserInfo, "accessToken"> | Omit<NoUserInfo, "accessToken">;

export function ConvexClientProvider({
  children,
  initialAuth,
}: {
  children: ReactNode;
  initialAuth: AuthKitInitialAuth;
}) {
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
    // Passing a callback still enables AuthKit's focus/visibility session probe.
    // Disable it entirely; Convex token refresh and middleware own auth recovery.
    <AuthKitProvider initialAuth={initialAuth} onSessionExpired={false}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
        {children}
      </ConvexProviderWithAuth>
    </AuthKitProvider>
  );
}
