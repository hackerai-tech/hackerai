"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  useAuth,
  useAccessToken,
} from "@workos-inc/authkit-nextjs/components";
import { CrossTabMutex } from "@/lib/auth/cross-tab-mutex";
import {
  clearExpiredSharedToken,
  getFreshSharedTokenWithFallback,
  TOKEN_FRESHNESS_MS,
} from "@/lib/auth/shared-token";

// Singleton mutex shared across all hook instances in this tab
const refreshMutex = new CrossTabMutex({
  lockKey: "hackerai-token-refresh",
  lockTimeoutMs: 15000,
  onLog: (msg) => console.log(`[Convex Auth] ${msg}`),
});

export function useSharedTokenCleanup(): void {
  useEffect(() => {
    const interval = setInterval(clearExpiredSharedToken, TOKEN_FRESHNESS_MS);
    return () => clearInterval(interval);
  }, []);
}

export type ConvexAuthState = {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: (args?: {
    forceRefreshToken?: boolean;
  }) => Promise<string | null>;
};

export type AuthKitDeps = {
  useAuth: typeof useAuth;
  useAccessToken: typeof useAccessToken;
  mutex: CrossTabMutex;
};

const defaultDeps: AuthKitDeps = {
  useAuth,
  useAccessToken,
  mutex: refreshMutex,
};

export function useAuthFromAuthKit(deps: AuthKitDeps = defaultDeps): ConvexAuthState {
  useSharedTokenCleanup();
  const { user, loading: isLoading } = deps.useAuth();
  const { getAccessToken, accessToken, refresh } = deps.useAccessToken();
  const accessTokenRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  const isAuthenticated = !!user;

  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken,
    }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
      if (!user) {
        return null;
      }

      try {
        if (forceRefreshToken) {
          // Convex is asking for a fresh token (current one was rejected).
          // Coordinate refresh across tabs to avoid redundant API calls.
          const refreshWithLock = async () => {
            const token = await deps.mutex.withLock(async () => {
              // Double-check after acquiring lock - another tab may have refreshed while we waited
              return getFreshSharedTokenWithFallback(async () => refresh());
            });
            // If lock timed out, fall back to getAccessToken
            return (
              token ?? (await getFreshSharedTokenWithFallback(getAccessToken))
            );
          };

          return getFreshSharedTokenWithFallback(refreshWithLock);
        }
        return (await getAccessToken()) ?? null;
      } catch {
        // On network errors during laptop wake, fall back to cached token.
        // Even if expired, Convex will treat it like null and clear auth.
        // AuthKit's tokenStore schedules automatic retries in the background.
        console.log("[Convex Auth] Using cached token during network issues");
        return accessTokenRef.current ?? null;
      }
    },
    [user, getAccessToken, refresh, deps.mutex],
  );

  return {
    isLoading,
    isAuthenticated,
    fetchAccessToken,
  };
}
