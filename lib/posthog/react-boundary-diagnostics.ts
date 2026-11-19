import {
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";

export type ReactBoundaryDiagnosticScope =
  "chat_content" | "chat_layout" | "unknown";

/** The exact React DOM failure family; callers compare it, never parse it. */
export const NULL_REMOVE_CHILD_MESSAGE =
  "Cannot read properties of null (reading 'removeChild')";

const WINDOW_MS = 1000;
const CAPACITY = 16;

type Catch = { at: number; scope: ReactBoundaryDiagnosticScope };
type Observer = {
  owner: string;
  catches: Array<Catch | undefined>;
  next: number;
  unsubscribe?: () => void;
};

// The current static mounted structure, independent of any analytics owner.
// Opaque tokens only, so presence is a boolean rather than a render count.
const mounted: Record<ReactBoundaryDiagnosticScope, Set<object>> = {
  chat_content: new Set(),
  chat_layout: new Set(),
  unknown: new Set(),
};
let active: Observer | undefined;

/** Closed mapping; any other value, including user-derived text, is "unknown". */
export function toReactBoundaryDiagnosticScope(
  scope: unknown,
): ReactBoundaryDiagnosticScope {
  return scope === "chat_content" || scope === "chat_layout"
    ? scope
    : "unknown";
}

/** Mark a mounted boundary's fixed scope; the disposer is idempotent. */
export function registerReactBoundaryScope(scope: unknown): () => void {
  try {
    const token = {};
    const tokens = mounted[toReactBoundaryDiagnosticScope(scope)];
    tokens.add(token);
    return () => {
      tokens.delete(token);
    };
  } catch {
    return () => {};
  }
}

const clear = (observer: Observer | undefined) => {
  observer?.catches.fill(undefined);
};

/** Both analytics owner reads still name this current observer's owner. */
function ownsCurrent(observer: Observer): boolean {
  const owner = getIdentifiedAnalyticsUserId();
  return (
    active === observer &&
    owner === observer.owner &&
    getPermittedAnalyticsUserId() === owner
  );
}

function stopObserver(observer: Observer) {
  try {
    observer.unsubscribe?.();
  } catch {
    /* Removing diagnostics cannot interrupt provider cleanup. */
  } finally {
    observer.unsubscribe = undefined;
    clear(observer);
    if (active === observer) active = undefined;
  }
}

/** Clear recent catches on a committed owner, consent or private-route change. */
export function clearReactBoundaryCatches() {
  clear(active);
}

/**
 * Collect recent catches for the identified owner until the returned disposer
 * runs. A newer start replaces this observer; a late disposer cannot stop it.
 */
export function startReactBoundaryDiagnostics(): () => void {
  let observer: Observer | undefined;
  try {
    if (active) stopObserver(active);
    const owner = getIdentifiedAnalyticsUserId();
    if (!owner || getPermittedAnalyticsUserId() !== owner) return () => {};
    const created: Observer = {
      owner,
      catches: new Array(CAPACITY),
      next: 0,
    };
    observer = created;
    active = created;
    // A->B->A clears here, so a returning owner starts with no old catches.
    created.unsubscribe = subscribeAuthenticatedAnalytics(() => {
      try {
        if (!ownsCurrent(created)) clear(created);
      } catch {
        clear(created);
      }
    });
    return () => {
      if (active === created) stopObserver(created);
    };
  } catch {
    if (observer) stopObserver(observer);
    return () => {};
  }
}

/** Record that a boundary caught the exact family; never the Error itself. */
export function recordReactBoundaryCatch(scope: unknown) {
  const observer = active;
  try {
    if (!observer) return;
    if (!ownsCurrent(observer)) {
      clear(observer);
      return;
    }
    const at = performance.now();
    if (!Number.isFinite(at) || at < 0) return;
    observer.catches[observer.next] = {
      at,
      scope: toReactBoundaryDiagnosticScope(scope),
    };
    observer.next = (observer.next + 1) % CAPACITY;
  } catch {
    clear(observer);
  }
}

const ageBucket = (age: number) =>
  age < 50 ? "lt_50ms" : age < 250 ? "lt_250ms" : "lt_1000ms";

/**
 * Nearby context only: a recent catch never identifies the retained
 * exception's Error, cause or recovery, and "none" does not prove that no
 * boundary caught it. `committedOwner` is the provider's current committed
 * analytics owner; without it nothing is attached.
 */
export function getReactBoundaryDiagnostics(
  committedOwner: string | null,
): Record<string, string | number | boolean> {
  const observer = active;
  try {
    if (
      typeof committedOwner !== "string" ||
      !committedOwner ||
      getIdentifiedAnalyticsUserId() !== committedOwner ||
      getPermittedAnalyticsUserId() !== committedOwner
    ) {
      clear(observer);
      return {};
    }
    const context = {
      hackerai_react_boundary_context_version: 1,
      hackerai_react_boundary_chat_content_mounted:
        mounted.chat_content.size > 0,
      hackerai_react_boundary_chat_layout_mounted: mounted.chat_layout.size > 0,
      hackerai_react_boundary_unknown_scope_mounted: mounted.unknown.size > 0,
    };
    if (!observer || observer.owner !== committedOwner) {
      clear(observer);
      return {
        ...context,
        hackerai_react_boundary_observer_state: "inactive",
        hackerai_react_boundary_recent_catch_state: "unavailable",
      };
    }
    const activeContext = {
      ...context,
      hackerai_react_boundary_observer_state: "active",
    };
    const unavailable = {
      ...activeContext,
      hackerai_react_boundary_recent_catch_state: "unavailable",
    };
    const now = performance.now();
    if (!Number.isFinite(now) || now < 0) {
      clear(observer);
      return unavailable;
    }
    let latest: Catch | undefined;
    const scopes = new Set<ReactBoundaryDiagnosticScope>();
    // Newest first, so write order breaks equal-timestamp ties.
    for (let offset = 1; offset <= CAPACITY; offset++) {
      const index = (observer.next - offset + CAPACITY) % CAPACITY;
      const sample = observer.catches[index];
      if (!sample) continue;
      const age = now - sample.at;
      // A clock regression makes every retained age untrustworthy.
      if (!Number.isFinite(age) || age < 0) {
        clear(observer);
        return unavailable;
      }
      if (age >= WINDOW_MS) {
        observer.catches[index] = undefined;
        continue;
      }
      latest ??= sample;
      scopes.add(sample.scope);
    }
    if (!latest) {
      return {
        ...activeContext,
        hackerai_react_boundary_recent_catch_state: "none",
      };
    }
    return {
      ...activeContext,
      hackerai_react_boundary_recent_catch_state: "observed",
      hackerai_react_boundary_recent_scope:
        scopes.size === 1 ? latest.scope : "multiple",
      hackerai_react_boundary_recent_age: ageBucket(now - latest.at),
    };
  } catch {
    clear(observer);
    return {};
  }
}
