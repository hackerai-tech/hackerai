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

/**
 * Which token decision boundary the provider's latest attempt went through,
 * and the existing branch that settled it. This is telemetry context only: it
 * does not prove which token a backend request carried or why it failed.
 * Mode names the callback policy, not whether a shared-tab cache, the AuthKit
 * store or a network request supplied the result.
 */
export type ConvexAuthTokenDecisionMode =
  "ordinary" | "forced_refresh" | "recovery";

export type ConvexAuthTokenDecisionOutcome =
  | "pending"
  | "token"
  | "null"
  | "cached_fallback"
  | "cooldown_fallback"
  | "exception_fallback"
  // The requesting auth context or recovery effect ended before the result
  // was used.
  | "context_superseded"
  | "no_owner";

// Wall-clock age since the latest attempt began or settled. Wall time, unlike
// performance.now(), keeps advancing while a sleeping computer is suspended.
export type ConvexAuthTokenDecisionAge =
  "lt_1s" | "lt_10s" | "lt_1m" | "lt_10m" | "gte_10m";

// Whether that attempt began under the provider's currently committed auth
// context, without retaining the user, session or organization behind it.
export type ConvexAuthTokenDecisionContext = "same" | "superseded";

const TOKEN_DECISION_MODES: readonly ConvexAuthTokenDecisionMode[] = [
  "ordinary",
  "forced_refresh",
  "recovery",
];
const TOKEN_DECISION_OUTCOMES: readonly ConvexAuthTokenDecisionOutcome[] = [
  "pending",
  "token",
  "null",
  "cached_fallback",
  "cooldown_fallback",
  "exception_fallback",
  "context_superseded",
  "no_owner",
];
const TOKEN_DECISION_AGES: readonly ConvexAuthTokenDecisionAge[] = [
  "lt_1s",
  "lt_10s",
  "lt_1m",
  "lt_10m",
  "gte_10m",
];
const TOKEN_DECISION_CONTEXTS: readonly ConvexAuthTokenDecisionContext[] = [
  "same",
  "superseded",
];

// What the Convex auth callback returned: a non-empty token, or null (or an
// empty value). The recovery effect returns nothing to Convex ("no_result");
// its outcome describes whether its getter produced a token.
export type ConvexAuthTokenDecisionResult =
  "pending" | "token" | "null" | "no_result";

const TOKEN_DECISION_RESULTS: readonly ConvexAuthTokenDecisionResult[] = [
  "pending",
  "token",
  "null",
  "no_result",
];

type TokenDecisionAttempt = {
  mode: ConvexAuthTokenDecisionMode;
  outcome: ConvexAuthTokenDecisionOutcome;
  result: ConvexAuthTokenDecisionResult;
  updatedAt: number;
  context: object;
};

/**
 * One provider instance's latest token attempt and auth-context generation.
 * In memory only: it holds no token, error or identity, and its objects are
 * compared by reference, never serialized.
 */
export type ConvexAuthTokenDecisionOwner = {
  latest: TokenDecisionAttempt | null;
  context: object;
};

export function createConvexAuthTokenDecisionOwner(): ConvexAuthTokenDecisionOwner {
  return { latest: null, context: {} };
}

/** Call when the provider commits a new auth context. */
export function advanceConvexAuthTokenDecisionContext(
  owner: ConvexAuthTokenDecisionOwner,
): void {
  owner.context = {};
}

const NOOP_SETTLE = () => {};

/**
 * Record the start of one token attempt as this owner's latest, and return
 * its settle function. Only the first settle of the still-latest attempt is
 * recorded, so stale completions cannot overwrite a newer attempt's evidence.
 * A callback invoked for an older auth context is not observed at all, so it
 * cannot replace the current context's evidence; an attempt whose context
 * changes while it is pending still reports that switch.
 * Pass `returnedToken` only for callbacks that return a value to Convex.
 * Never throws, so it cannot redirect the caller's existing error handling.
 */
export function beginConvexAuthTokenDecision(
  owner: ConvexAuthTokenDecisionOwner,
  mode: ConvexAuthTokenDecisionMode,
  currentContext: boolean,
): (
  outcome: Exclude<ConvexAuthTokenDecisionOutcome, "pending">,
  returnedToken?: boolean,
) => void {
  try {
    if (!currentContext) return NOOP_SETTLE;
    const attempt: TokenDecisionAttempt = {
      mode,
      outcome: "pending",
      result: "pending",
      updatedAt: Date.now(),
      context: owner.context,
    };
    owner.latest = attempt;
    return (outcome, returnedToken) => {
      try {
        if (owner.latest !== attempt || attempt.outcome !== "pending") return;
        attempt.outcome = outcome;
        attempt.result =
          returnedToken === undefined
            ? "no_result"
            : returnedToken
              ? "token"
              : "null";
        attempt.updatedAt = Date.now();
      } catch {
        // Diagnostics must not change token handling.
      }
    };
  } catch {
    return NOOP_SETTLE;
  }
}

function tokenDecisionAge(ms: number): ConvexAuthTokenDecisionAge {
  // A wall clock that moved backwards still means the attempt is recent.
  if (ms < 1_000) return "lt_1s";
  if (ms < 10_000) return "lt_10s";
  if (ms < 60_000) return "lt_1m";
  if (ms < 600_000) return "lt_10m";
  return "gte_10m";
}

// Long-lived readers (the Desktop bridge) outlive the provider render that
// created them, so they read the latest committed provider instead. Each
// commit's snapshot object is its owner token for cleanup.
let committedSnapshot: {
  state: ConvexAuthProviderState;
  tokenDecisions?: ConvexAuthTokenDecisionOwner;
} | null = null;

/**
 * Publish from a layout effect only, so discarded or server renders never
 * publish. The returned cleanup clears only this commit's own snapshot.
 */
export function publishConvexAuthProviderState(
  state: ConvexAuthProviderState,
  tokenDecisions?: ConvexAuthTokenDecisionOwner,
): () => void {
  const snapshot = { state, tokenDecisions };
  committedSnapshot = snapshot;
  return () => {
    if (committedSnapshot === snapshot) committedSnapshot = null;
  };
}

export function readConvexAuthProviderState(): ConvexAuthProviderState {
  return committedSnapshot?.state ?? "unavailable";
}

/**
 * The committed provider's latest token attempt, or undefined when no provider
 * is committed or it has not attempted one. `attempt` is an opaque identity
 * for in-memory comparison only.
 */
export function readConvexAuthTokenDecision():
  | {
      mode: ConvexAuthTokenDecisionMode;
      outcome: ConvexAuthTokenDecisionOutcome;
      result: ConvexAuthTokenDecisionResult;
      age: ConvexAuthTokenDecisionAge;
      context: ConvexAuthTokenDecisionContext;
      attempt: object;
    }
  | undefined {
  const owner = committedSnapshot?.tokenDecisions;
  const attempt = owner?.latest;
  if (!owner || !attempt) return undefined;
  return {
    mode: attempt.mode,
    outcome: attempt.outcome,
    result: attempt.result,
    age: tokenDecisionAge(Date.now() - attempt.updatedAt),
    context: attempt.context === owner.context ? "same" : "superseded",
    attempt,
  };
}

export type ClosedConvexAuthTokenDecision = {
  mode: ConvexAuthTokenDecisionMode | "unavailable";
  outcome: ConvexAuthTokenDecisionOutcome | "unavailable";
  result: ConvexAuthTokenDecisionResult | "unavailable";
  age: ConvexAuthTokenDecisionAge | "unavailable";
  context: ConvexAuthTokenDecisionContext | "unavailable";
  // In-memory identity for comparing two reads; never serialize it.
  attempt: object | null;
};

// A fresh record per read, so no caller can alter a later read's result.
function unavailableTokenDecision(): ClosedConvexAuthTokenDecision {
  return {
    mode: "unavailable",
    outcome: "unavailable",
    result: "unavailable",
    age: "unavailable",
    context: "unavailable",
    attempt: null,
  };
}

/** An own data property only: never run a getter or read an inherited value. */
function ownDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function closedValue<T>(known: readonly T[], value: unknown): T | undefined {
  return known.find((candidate) => candidate === value);
}

// Only known closed values may reach analytics; other fields are ignored. Any
// missing, malformed or throwing read leaves the whole decision unavailable.
export function readClosedConvexAuthTokenDecision(
  read: (() => unknown) | undefined,
): ClosedConvexAuthTokenDecision {
  try {
    const value: unknown = read?.();
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return unavailableTokenDecision();
    }
    const mode = closedValue(TOKEN_DECISION_MODES, ownDataValue(value, "mode"));
    const outcome = closedValue(
      TOKEN_DECISION_OUTCOMES,
      ownDataValue(value, "outcome"),
    );
    const result = closedValue(
      TOKEN_DECISION_RESULTS,
      ownDataValue(value, "result"),
    );
    const age = closedValue(TOKEN_DECISION_AGES, ownDataValue(value, "age"));
    const context = closedValue(
      TOKEN_DECISION_CONTEXTS,
      ownDataValue(value, "context"),
    );
    const attempt = ownDataValue(value, "attempt");
    if (!mode || !outcome || !result || !age || !context) {
      return unavailableTokenDecision();
    }
    return {
      mode,
      outcome,
      result,
      age,
      context,
      attempt: typeof attempt === "object" && attempt !== null ? attempt : null,
    };
  } catch {
    return unavailableTokenDecision();
  }
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
