"use client";

import { ReactNode, useCallback, useRef } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithAuth } from "convex/react";
import {
  AuthKitProvider,
  useAuth,
  useAccessToken,
} from "@workos-inc/authkit-nextjs/components";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <AuthKitProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
        {children}
      </ConvexProviderWithAuth>
    </AuthKitProvider>
  );
}

function useAuthFromAuthKit() {
  const { user, loading: isLoading } = useAuth();
  const {
    accessToken,
    loading: tokenLoading,
    error: tokenError,
  } = useAccessToken();
  const loading = (isLoading ?? false) || (tokenLoading ?? false);
  const authenticated = !!user && !!accessToken && !loading;

  const stableAccessToken = useRef<string | null>(null);
  if (accessToken && !tokenError) {
    stableAccessToken.current = accessToken;
  }

  const fetchAccessToken = useCallback(async () => {
    // If we have a stable token and no error, use it
    if (stableAccessToken.current && !tokenError) {
      return stableAccessToken.current;
    }

    // If token is missing or error exists, try to refresh session
    if (tokenError || !accessToken) {
      try {
        // Force a session refresh by calling the entitlements API
        // This will trigger WorkOS to refresh the session cookie
        const response = await fetch("/api/entitlements", {
          credentials: "include",
          cache: "no-cache", // Force fresh request
        });

        if (response.ok) {
          // Don't return anything - let the auth hook re-run with fresh token
          return null;
        }
      } catch (error) {
        // Silently handle refresh errors
      }
    }

    return null;
  }, [tokenError, accessToken]);

  return {
    isLoading: loading,
    isAuthenticated: authenticated,
    fetchAccessToken,
  };
}
