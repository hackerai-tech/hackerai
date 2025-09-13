"use client";

import { ReactNode, useCallback, useState } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuth } from "convex/react";
import {
  AuthKitProvider,
  useAuth,
  useAccessToken,
} from "@workos-inc/authkit-nextjs/components";

export function ConvexClientProvider({
  children,
  expectAuth,
}: {
  children: ReactNode;
  expectAuth?: boolean;
}) {
  const [convex] = useState(() => {
    return new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!, {
      expectAuth,
    });
  });
  return (
    <AuthKitProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
        {children}
      </ConvexProviderWithAuth>
    </AuthKitProvider>
  );
}

function useAuthFromAuthKit() {
  const { user, loading } = useAuth();
  const { accessToken, getAccessToken, refresh } = useAccessToken();

  const shouldForceLogout = (value: unknown): boolean => {
    const message =
      typeof value === "string"
        ? value
        : value && typeof value === "object" && "message" in value
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (value as any).message
          : undefined;
    if (!message) return false;
    const normalized = String(message).toLowerCase();
    if (normalized.includes("invalid_grant")) return true;
    if (normalized.includes("session has already ended")) return true;
    if (normalized.includes("failed to refresh session")) return true;
    return false;
  };

  const hasIncompleteAuth =
    (!!user && !accessToken) || (!user && !!accessToken);
  const isLoading = loading || hasIncompleteAuth;
  const authenticated = !!user && !!accessToken;

  // Create a stable fetchAccessToken function
  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken,
    }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
      if (!user) {
        return null;
      }

      try {
        if (forceRefreshToken) {
          return (await refresh()) ?? null;
        }

        return (await getAccessToken()) ?? null;
      } catch (error) {
        if (shouldForceLogout(error) && typeof window !== "undefined") {
          // Redirect immediately if the session has ended / invalid_grant
          window.location.href = "/logout";
          return null;
        }
        console.error("Failed to get access token:", error);
        return null;
      }
    },
    [user, refresh, getAccessToken],
  );

  return {
    isLoading,
    isAuthenticated: authenticated,
    fetchAccessToken,
  };
}
