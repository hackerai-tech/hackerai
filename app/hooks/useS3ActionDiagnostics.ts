import { useCallback, useLayoutEffect, useRef } from "react";
import { useConvexAuth } from "convex/react";
import { v4 as uuidv4 } from "uuid";
import {
  captureQueuedAuthenticatedEvent,
  getPermittedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";
import {
  classifyFileActionAuthFailure,
  FILE_ACTION_AUTH_DIAGNOSTIC_EVENT,
  FILE_ACTION_AUTH_DIAGNOSTIC_VERSION,
  FILE_ACTION_OPERATION,
  projectFileActionAuthDiagnostic,
  readClosedConvexClientAuthState,
  type ConvexClientAuthState,
  type FileActionCaller,
  type FileActionInputRelation,
} from "@/lib/analytics/file-auth-diagnostics";
import {
  readClosedConvexAuthProviderState,
  readClosedConvexAuthTokenDecision,
  readConvexAuthProviderState,
  readConvexAuthTokenDecision,
  type ClosedConvexAuthTokenDecision,
  type ConvexAuthProviderState,
} from "@/lib/auth/convex-auth-diagnostics";

/**
 * One analytics owner's lifetime within one mounted observer. Any owner or
 * consent change (including A→B→A) and unmount replace it, so a pending
 * failure can only be reported under the scope it was invoked in.
 */
type ObserverScope = {
  owner: string | null;
  id: string | undefined;
  // In memory only: the previous opaque file ID, never reported or hashed.
  lastFileId: string | undefined;
  invoked: boolean;
};

type Invocation = {
  scope: ObserverScope;
  convexAuth: ConvexClientAuthState;
  providerState: ConvexAuthProviderState;
  tokenDecision: ClosedConvexAuthTokenDecision;
  inputRelation: FileActionInputRelation;
};

function createScope(owner: string | null): ObserverScope {
  let id: string | undefined;
  try {
    id = globalThis.crypto?.randomUUID?.();
  } catch {
    id = undefined;
  }
  return { owner, id, lastFileId: undefined, invoked: false };
}

function readOwner(): string | null {
  try {
    const owner = getPermittedAnalyticsUserId();
    return typeof owner === "string" && owner !== "" ? owner : null;
  } catch {
    return null;
  }
}

// Only an own string `fileId` on a plain argument object; never a getter.
function readFileId(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(args, "fileId");
  return descriptor &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

/** Relate this invocation's input to the scope's previous one, then record it. */
function recordInvocation(
  scope: ObserverScope,
  fileId: string | undefined,
): FileActionInputRelation {
  const relation: FileActionInputRelation =
    fileId === undefined
      ? "unavailable"
      : !scope.invoked
        ? "first"
        : scope.lastFileId === fileId
          ? "same"
          : "different";
  scope.lastFileId = fileId;
  scope.invoked = true;
  return relation;
}

function readTokenDecision(): ClosedConvexAuthTokenDecision {
  return readClosedConvexAuthTokenDecision(readConvexAuthTokenDecision);
}

/**
 * Observe one protected S3 action for its caller and return a stable function
 * that invokes it exactly as before: same arguments, same returned promise,
 * same result and rejection. On an exact known guard or redacted failure, a
 * companion diagnostic records the committed Convex, provider and latest-token
 * context at invocation and at rejection. That context does not identify the
 * token the request carried or the backend principal. Observation never
 * awaits analytics, adds requests or throws into the caller.
 */
export function useS3ActionDiagnostics<
  F extends (...args: never[]) => Promise<unknown>,
>(caller: FileActionCaller, action: F): F {
  const convexAuth = useConvexAuth();
  const renderedAuth = readClosedConvexClientAuthState(() => convexAuth);
  const committedAuth = useRef<ConvexClientAuthState>("unavailable");
  const scopeRef = useRef<ObserverScope | null>(null);

  // Layout effects publish only committed render state, before passive effects
  // or event handlers can invoke the action.
  useLayoutEffect(() => {
    committedAuth.current = renderedAuth;
  });

  useLayoutEffect(() => {
    scopeRef.current = createScope(readOwner());
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = subscribeAuthenticatedAnalytics(() => {
        try {
          const owner = readOwner();
          if (scopeRef.current && scopeRef.current.owner !== owner) {
            scopeRef.current = createScope(owner);
          }
        } catch {
          // Observation must not affect analytics listeners.
        }
      });
    } catch {
      unsubscribe = undefined;
    }
    return () => {
      scopeRef.current = null;
      try {
        unsubscribe?.();
      } catch {
        // Nothing else to release.
      }
    };
  }, []);

  const begin = useCallback(
    (args: unknown): Invocation | null => {
      try {
        let scope = scopeRef.current;
        if (!scope) return null;
        const owner = readOwner();
        if (scope.owner !== owner) {
          scope = createScope(owner);
          scopeRef.current = scope;
        }
        if (owner === null) return null;
        return {
          scope,
          convexAuth: committedAuth.current,
          providerState: readClosedConvexAuthProviderState(
            readConvexAuthProviderState,
          ),
          tokenDecision: readTokenDecision(),
          // Uploads never compare inputs (or retain file names).
          inputRelation:
            caller === "upload"
              ? recordInvocation(scope, undefined)
              : recordInvocation(scope, readFileId(args)),
        };
      } catch {
        return null;
      }
    },
    [caller],
  );

  const settleRejected = useCallback(
    (invocation: Invocation, error: unknown) => {
      try {
        const scope = scopeRef.current;
        // Unmounted, or the owner/consent changed since invocation.
        if (!scope || scope !== invocation.scope || readOwner() !== scope.owner)
          return;
        const operation = FILE_ACTION_OPERATION[caller];
        const failure = classifyFileActionAuthFailure(error, operation);
        if (!failure) return;
        const tokenDecision = readTokenDecision();
        const requestToken = invocation.tokenDecision;
        const raw: Record<string, unknown> = {
          file_action_auth_diagnostic_version:
            FILE_ACTION_AUTH_DIAGNOSTIC_VERSION,
          caller,
          operation,
          ...failure,
          request_convex_auth_state: invocation.convexAuth,
          convex_auth_state: committedAuth.current,
          request_provider_state: invocation.providerState,
          provider_state: readClosedConvexAuthProviderState(
            readConvexAuthProviderState,
          ),
          request_token_mode: requestToken.mode,
          request_token_outcome: requestToken.outcome,
          request_token_result: requestToken.result,
          request_token_age: requestToken.age,
          request_token_context: requestToken.context,
          token_mode: tokenDecision.mode,
          token_outcome: tokenDecision.outcome,
          token_result: tokenDecision.result,
          token_age: tokenDecision.age,
          token_context: tokenDecision.context,
          // "same": the invocation's attempt was still the latest here.
          token_attempt:
            requestToken.attempt && tokenDecision.attempt
              ? requestToken.attempt === tokenDecision.attempt
                ? "same"
                : "changed"
              : "unavailable",
          input_relation: invocation.inputRelation,
          observer_scope_id: scope.id,
        };
        // The same strict schema before_send applies.
        const properties = projectFileActionAuthDiagnostic((key) => raw[key]);
        if (!properties) return;
        captureQueuedAuthenticatedEvent({
          event: FILE_ACTION_AUTH_DIAGNOSTIC_EVENT,
          properties,
          dedupeKey: uuidv4(),
        });
      } catch {
        // Diagnostics must not change the caller's failure handling.
      }
    },
    [caller],
  );

  const observed = useCallback(
    (...args: Parameters<F>) => {
      const invocation = begin(args[0]);
      const result = action(...args);
      if (invocation) {
        try {
          // A side observation of the same promise; the caller still receives
          // (and handles) the original promise and its rejection.
          Promise.prototype.then.call(result, undefined, (error: unknown) =>
            settleRejected(invocation, error),
          );
        } catch {
          // A non-native result is returned unobserved.
        }
      }
      return result;
    },
    [action, begin, settleRejected],
  );
  return observed as unknown as F;
}
