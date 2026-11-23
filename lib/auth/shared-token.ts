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

function isValidSharedToken(parsed: unknown): parsed is SharedToken {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as SharedToken).token === "string" &&
    typeof (parsed as SharedToken).refreshedAt === "number"
  );
}

export function getSharedToken(): SharedToken | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  try {
    const data = localStorage.getItem(SHARED_TOKEN_KEY);
    if (!data) return null;
    const parsed: unknown = JSON.parse(data);
    if (isValidSharedToken(parsed)) {
      return parsed;
    }
    return null;
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
      const parsed: unknown = JSON.parse(data);
      if (
        isValidSharedToken(parsed) &&
        Date.now() - parsed.refreshedAt >= TOKEN_FRESHNESS_MS
      ) {
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
 * Get a fresh shared token that this tab accepts, null otherwise. The key is
 * shared by every tab in the browser profile and is not bound to an account,
 * so callers must reject another account's or session's token.
 */
export function getFreshSharedToken(
  isAccepted: (token: string) => boolean,
): string | null {
  const sharedToken = getSharedToken();
  if (isTokenFresh(sharedToken) && isAccepted(sharedToken!.token)) {
    return sharedToken!.token;
  }
  return null;
}

/**
 * Get an accepted fresh shared token, or execute fallback. An accepted
 * fallback token is stored for other tabs; a rejected one is never shared.
 */
export async function getFreshSharedTokenWithFallback(
  fallback: () => Promise<string | null | undefined>,
  isAccepted: (token: string) => boolean,
): Promise<string | null> {
  const freshToken = getFreshSharedToken(isAccepted);
  if (freshToken) {
    return freshToken;
  }

  const newToken = await fallback();
  if (newToken && isAccepted(newToken)) {
    setSharedToken(newToken);
  }
  return newToken ?? null;
}
