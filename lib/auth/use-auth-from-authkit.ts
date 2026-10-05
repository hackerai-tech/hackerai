"use client";

import { useCallback, useEffect, useRef, useMemo, useState } from "react";
import { useAuth, useAccessToken } from "@workos-inc/authkit-nextjs/components";
import { CrossTabMutex } from "@/lib/auth/cross-tab-mutex";
import {
  clearExpiredSharedToken,
  getFreshSharedTokenWithFallback,
  TOKEN_FRESHNESS_MS,
} from "@/lib/auth/shared-token";
import { isCrossTabTokenSharingEnabled } from "@/lib/auth/feature-flags";

// Singleton mutex shared across all hook instances in this tab
const refreshMutex = new CrossTabMutex({
  lockKey: "hackerai-token-refresh",
  lockTimeoutMs: 15000,
  onLog: (msg) => console.log(`[Convex Auth] ${msg}`),
});

const REFRESH_COOLDOWN_MS = 10_000;

export function useSharedTokenCleanup(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(clearExpiredSharedToken, TOKEN_FRESHNESS_MS);
    return () => clearInterval(interval);
  }, [enabled]);
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
  isCrossTabEnabled?: (userId: string | undefined) => boolean;
};

const defaultDeps: AuthKitDeps = {
  useAuth,
  useAccessToken,
  mutex: refreshMutex,
  isCrossTabEnabled: isCrossTabTokenSharingEnabled,
};

export function useAuthFromAuthKit(
  deps: AuthKitDeps = defaultDeps,
): ConvexAuthState {
  const {
    user,
    loading: isLoading,
    organizationId,
    sessionId,
    refreshAuth,
  } = deps.useAuth();
  const { getAccessToken, accessToken, refresh } = deps.useAccessToken();
  const accessTokenRef = useRef<string | undefined>(undefined);
  const lastRefreshErrorAt = useRef<number>(0);
  const hasResolvedOrgRef = useRef(false);
  const authContext = JSON.stringify([user?.id, sessionId, organizationId]);
  const authContextRef = useRef(authContext);
  authContextRef.current = authContext;
  const [recovery, setRecovery] = useState<{
    context: string;
    failedToken: string | undefined;
  } | null>(null);
  const isRecovering = !!user && recovery?.context === authContext;
  const sessionRecoveryRef = useRef<{
    userId: string;
    startedAt: number;
    pending: Promise<boolean>;
  } | null>(null);

  const isCrossTabEnabled = useMemo(
    () => (deps.isCrossTabEnabled ?? isCrossTabTokenSharingEnabled)(user?.id),
    [deps.isCrossTabEnabled, user?.id],
  );

  useSharedTokenCleanup(isCrossTabEnabled);

  // Eagerly ensure session is scoped to the user's organization so JWTs
  // include entitlements (e.g. "pro-plus-plan"). Running this in an effect
  // (rather than inside fetchAccessToken) avoids a mid-auth-flow state
  // change that would cause Convex to briefly flip isLoading back to true,
  // producing a visible loading-screen flash.
  useEffect(() => {
    if (organizationId && !hasResolvedOrgRef.current && refreshAuth) {
      refreshAuth({ organizationId })
        .then(() => {
          hasResolvedOrgRef.current = true;
        })
        .catch(() => {
          // Non-fatal: the token may still include entitlements if the
          // session was already org-scoped.
        });
    }
  }, [organizationId, refreshAuth]);

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  const isAuthenticated = !!user;

  useEffect(() => {
    setRecovery((current) =>
      current?.context === authContext ? current : null,
    );
    lastRefreshErrorAt.current = 0;
    sessionRecoveryRef.current = null;
  }, [authContext]);

  const reconcileMissingToken = useCallback(async (): Promise<boolean> => {
    if (!user || !refreshAuth) return false;
    const previous = sessionRecoveryRef.current;
    if (
      previous?.userId === user.id &&
      Date.now() - previous.startedAt < 10_000
    ) {
      return previous.pending;
    }

    // Token refresh updates AuthKit's token store, but not its cached user.
    // Reconcile that user before Convex renders the signed-out page. Unlike
    // getAuth, refreshAuth preserves the user on transient request failures.
    const pending = (async () => {
      try {
        const result = await refreshAuth();
        return result !== undefined;
      } catch {
        // A failed session check is not evidence that the user signed out.
        return true;
      }
    })();
    sessionRecoveryRef.current = {
      userId: user.id,
      startedAt: Date.now(),
      pending,
    };
    return pending;
  }, [user, refreshAuth]);

  const startRecovery = useCallback(() => {
    if (authContextRef.current !== authContext) return;
    setRecovery((current) =>
      current?.context === authContext
        ? current
        : { context: authContext, failedToken: accessTokenRef.current },
    );
  }, [authContext]);

  // A token-store refresh alone does not restart Convex after it has cleared
  // auth: AuthKit's getAccessToken/refresh callbacks have stable identities.
  // Keep transient failures in loading state, then leave that state only after
  // a usable token or a successful session check. The loading transition makes
  // ConvexProviderWithAuth register auth again without rotating every token.
  useEffect(() => {
    if (!isRecovering) return;
    let cancelled = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    let nextAttemptAt = lastRefreshErrorAt.current + REFRESH_COOLDOWN_MS;

    const retry = async () => {
      clearTimeout(timer);
      if (cancelled || pending) return;
      if (
        navigator.onLine === false ||
        document.visibilityState === "hidden" ||
        Date.now() < nextAttemptAt
      ) {
        timer = setTimeout(retry, REFRESH_COOLDOWN_MS);
        return;
      }
      pending = true;
      try {
        // AuthKit checks JWT expiry and deduplicates concurrent wake refreshes.
        const token = await getAccessToken();
        if (cancelled || authContextRef.current !== recovery?.context) return;
        const recoveryFailed = !token && (await reconcileMissingToken());
        if (cancelled || authContextRef.current !== recovery?.context) return;
        if (!recoveryFailed) {
          accessTokenRef.current = token ?? undefined;
          lastRefreshErrorAt.current = 0;
          setRecovery(null);
          return;
        }
      } catch {
        // A transport/provider failure is not evidence of sign-out.
      } finally {
        pending = false;
      }
      if (!cancelled) {
        lastRefreshErrorAt.current = Date.now();
        nextAttemptAt = Date.now() + REFRESH_COOLDOWN_MS;
        timer = setTimeout(retry, REFRESH_COOLDOWN_MS);
      }
    };

    // The SDK may have already recovered in the background during cooldown.
    if (accessToken && accessToken !== recovery?.failedToken) nextAttemptAt = 0;
    void retry();
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    window.addEventListener("pageshow", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
      window.removeEventListener("pageshow", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [
    isRecovering,
    recovery,
    accessToken,
    getAccessToken,
    reconcileMissingToken,
  ]);

  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken,
    }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
      if (!user) {
        return null;
      }

      try {
        let token: string | null | undefined;
        if (forceRefreshToken) {
          // Cooldown: skip refresh if we recently hit an error (e.g., rate limit)
          // to prevent Convex retry loops from hammering the server
          if (Date.now() - lastRefreshErrorAt.current < REFRESH_COOLDOWN_MS) {
            console.log(
              "[Convex Auth] Skipping refresh during cooldown, using cached token",
            );
            return accessTokenRef.current ?? null;
          }

          // Use new cross-tab coordination if feature flag is enabled
          if (isCrossTabEnabled) {
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

            token = await getFreshSharedTokenWithFallback(refreshWithLock);
          } else {
            // Legacy behavior: direct refresh without cross-tab coordination
            token = await refresh();
          }
        } else {
          token = await getAccessToken();
        }
        if (authContextRef.current !== authContext) return null;
        if (!token) {
          const cachedToken = accessTokenRef.current;
          const recoveryFailed = await reconcileMissingToken();
          if (recoveryFailed) {
            startRecovery();
            return cachedToken ?? null;
          }
          accessTokenRef.current = undefined;
        } else {
          accessTokenRef.current = token;
          sessionRecoveryRef.current = null;
        }
        return token ?? null;
      } catch {
        if (authContextRef.current !== authContext) return null;
        // Preserve the shell while the token is unavailable. Returning an old
        // token alone can leave Convex signed out even after AuthKit recovers.
        lastRefreshErrorAt.current = Date.now();
        startRecovery();
        console.log("[Convex Auth] Using cached token during network issues");
        return accessTokenRef.current ?? null;
      }
    },
    [
      user,
      getAccessToken,
      refresh,
      deps.mutex,
      isCrossTabEnabled,
      reconcileMissingToken,
      startRecovery,
      authContext,
    ],
  );

  return {
    isLoading: isLoading || isRecovering,
    isAuthenticated,
    fetchAccessToken,
  };
}
