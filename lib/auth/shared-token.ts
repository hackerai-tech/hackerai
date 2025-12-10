/**
 * Shared token storage for cross-tab coordination.
 *
 * Allows tabs to share refreshed tokens via localStorage,
 * preventing redundant API calls when multiple tabs need fresh tokens.
 */

export const SHARED_TOKEN_KEY = "hackerai-shared-token";
export const TOKEN_FRESHNESS_MS = 60000; // Consider token "fresh" if refreshed within 60s

export type SharedToken = {
  token: string;
  refreshedAt: number;
};

export function getSharedToken(): SharedToken | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  try {
    const data = localStorage.getItem(SHARED_TOKEN_KEY);
    if (!data) return null;
    return JSON.parse(data) as SharedToken;
  } catch {
    return null;
  }
}

export function setSharedToken(token: string): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    const data: SharedToken = { token, refreshedAt: Date.now() };
    localStorage.setItem(SHARED_TOKEN_KEY, JSON.stringify(data));
  } catch {
    // Ignore localStorage errors
  }
}

export function clearExpiredSharedToken(): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    const data = localStorage.getItem(SHARED_TOKEN_KEY);
    if (data) {
      const parsed = JSON.parse(data) as SharedToken;
      if (Date.now() - parsed.refreshedAt >= TOKEN_FRESHNESS_MS) {
        localStorage.removeItem(SHARED_TOKEN_KEY);
      }
    }
  } catch {
    // Ignore
  }
}

export function isTokenFresh(sharedToken: SharedToken | null): boolean {
  if (!sharedToken) return false;
  return Date.now() - sharedToken.refreshedAt < TOKEN_FRESHNESS_MS;
}

export function clearSharedToken(): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(SHARED_TOKEN_KEY);
  } catch {
    // Ignore
  }
}

/**
 * Get fresh shared token if available.
 * Returns the token string if fresh, null otherwise.
 */
export function getFreshSharedToken(): string | null {
  const sharedToken = getSharedToken();
  if (isTokenFresh(sharedToken)) {
    return sharedToken!.token;
  }
  return null;
}

/**
 * Get fresh shared token, or execute fallback.
 * If fallback returns a token, it's stored for other tabs.
 */
export async function getFreshSharedTokenWithFallback(
  fallback: () => Promise<string | null | undefined>,
): Promise<string | null> {
  const freshToken = getFreshSharedToken();
  if (freshToken) {
    return freshToken;
  }

  const newToken = await fallback();
  if (newToken) {
    setSharedToken(newToken);
  }
  return newToken ?? null;
}

