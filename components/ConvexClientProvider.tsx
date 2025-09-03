"use client";

import { ReactNode, useCallback, useRef, useEffect, useState } from "react";
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

  // Add timeout to prevent infinite loading states
  const [loadingTimeout, setLoadingTimeout] = useState(false);

  useEffect(() => {
    if (loading && !loadingTimeout) {
      const timeout = setTimeout(() => {
        console.error(
          "🚨 [ConvexAuth] Loading timeout - forcing authentication failure",
        );
        setLoadingTimeout(true);
      }, 30000); // 30 second timeout

      return () => clearTimeout(timeout);
    } else if (!loading) {
      setLoadingTimeout(false);
    }
  }, [loading, loadingTimeout]);

  // Override loading state if timeout occurred
  const finalLoading = loading && !loadingTimeout;
  const finalAuthenticated = authenticated || (loadingTimeout && !!user);

  const stableAccessToken = useRef<string | null>(null);
  const prevLoadingState = useRef<boolean | null>(null);
  const prevAuthState = useRef<boolean | null>(null);

  // Log auth state changes for debugging
  useEffect(() => {
    const currentLoading = finalLoading;
    const currentAuth = finalAuthenticated;

    if (
      prevLoadingState.current !== currentLoading ||
      prevAuthState.current !== currentAuth
    ) {
      console.log("🔐 [ConvexAuth] State change:", {
        timestamp: new Date().toISOString(),
        isLoading: currentLoading,
        isAuthenticated: currentAuth,
        userLoading: isLoading,
        tokenLoading: tokenLoading,
        hasUser: !!user,
        hasAccessToken: !!accessToken,
        tokenError: tokenError?.message || null,
        userId: user?.id || null,
        loadingTimeout: loadingTimeout,
        finalLoading: finalLoading,
        finalAuthenticated: finalAuthenticated,
      });

      prevLoadingState.current = currentLoading;
      prevAuthState.current = currentAuth;
    }
  }, [
    finalLoading,
    finalAuthenticated,
    isLoading,
    tokenLoading,
    user,
    accessToken,
    tokenError,
    loadingTimeout,
  ]);

  // Log token errors specifically
  useEffect(() => {
    if (tokenError) {
      console.error("🚨 [ConvexAuth] Token error detected:", {
        timestamp: new Date().toISOString(),
        error: tokenError.message,
        stack: tokenError.stack,
        hasUser: !!user,
        isLoading,
        tokenLoading,
      });
    }
  }, [tokenError, user, isLoading, tokenLoading]);

  if (accessToken && !tokenError) {
    stableAccessToken.current = accessToken;
  }

  const fetchAccessToken = useCallback(async () => {
    console.log("🔑 [ConvexAuth] Fetching access token:", {
      timestamp: new Date().toISOString(),
      hasStableToken: !!stableAccessToken.current,
      hasTokenError: !!tokenError,
      tokenErrorMessage: tokenError?.message || null,
    });

    // If we have a stable token and no error, use it
    if (stableAccessToken.current && !tokenError) {
      return stableAccessToken.current;
    }

    // If token is missing or error exists, try to refresh session
    if (tokenError || !accessToken) {
      console.log(
        "🔄 [ConvexAuth] Token missing/error, attempting session refresh...",
      );

      try {
        // Force a session refresh by calling the entitlements API
        // This will trigger WorkOS to refresh the session cookie
        const response = await fetch("/api/entitlements", {
          credentials: "include",
          cache: "no-cache", // Force fresh request
        });

        if (response.ok) {
          console.log(
            "✅ [ConvexAuth] Session refresh successful, waiting for new token...",
          );
          // Don't return anything - let the auth hook re-run with fresh token
          return null;
        } else {
          console.warn(
            "⚠️ [ConvexAuth] Session refresh failed:",
            response.status,
          );
        }
      } catch (error) {
        console.error("💥 [ConvexAuth] Session refresh error:", error);
      }
    }

    return null;
  }, [tokenError, accessToken]);

  return {
    isLoading: finalLoading,
    isAuthenticated: finalAuthenticated,
    fetchAccessToken,
  };
}
