/**
 * Committed provenance of the Convex auth provider's loading state: whether
 * AuthKit is loading and/or our token recovery holds Convex in loading.
 * This is telemetry context only. "ready" describes these provider booleans,
 * not the backend principal, token validity or network health.
 */
export type ConvexAuthProviderState =
  | "owner_absent"
  | "authkit_loading"
  | "token_recovery"
  | "authkit_loading_and_token_recovery"
  | "ready"
  | "unavailable";

const CONVEX_AUTH_PROVIDER_STATES: readonly ConvexAuthProviderState[] = [
  "owner_absent",
  "authkit_loading",
  "token_recovery",
  "authkit_loading_and_token_recovery",
  "ready",
  "unavailable",
];

export function deriveConvexAuthProviderState({
  ownerPresent,
  authKitLoading,
  tokenRecovering,
}: {
  ownerPresent: boolean;
  authKitLoading: boolean;
  tokenRecovering: boolean;
}): ConvexAuthProviderState {
  if (!ownerPresent) return "owner_absent";
  if (authKitLoading) {
    return tokenRecovering
      ? "authkit_loading_and_token_recovery"
      : "authkit_loading";
  }
  return tokenRecovering ? "token_recovery" : "ready";
}

// Long-lived readers (the Desktop bridge) outlive the provider render that
// created them, so they read the latest committed provider instead. Each
// commit's snapshot object is its owner token for cleanup.
let committedSnapshot: { state: ConvexAuthProviderState } | null = null;

/**
 * Publish from a layout effect only, so discarded or server renders never
 * publish. The returned cleanup clears only this commit's own snapshot.
 */
export function publishConvexAuthProviderState(
  state: ConvexAuthProviderState,
): () => void {
  const snapshot = { state };
  committedSnapshot = snapshot;
  return () => {
    if (committedSnapshot === snapshot) committedSnapshot = null;
  };
}

export function readConvexAuthProviderState(): ConvexAuthProviderState {
  return committedSnapshot?.state ?? "unavailable";
}

// Only a known closed value may reach analytics; anything else is unavailable.
export function readClosedConvexAuthProviderState(
  read: (() => unknown) | undefined,
): ConvexAuthProviderState {
  try {
    const state = read?.();
    return (
      CONVEX_AUTH_PROVIDER_STATES.find((known) => known === state) ??
      "unavailable"
    );
  } catch {
    return "unavailable";
  }
}
