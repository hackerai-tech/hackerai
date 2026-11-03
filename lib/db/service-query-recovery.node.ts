import { AsyncLocalStorage } from "node:async_hooks";
import {
  serviceQueryRecoveryKey,
  serviceQueryRecoveryRuntime,
} from "./service-query-recovery";

type Scope = {
  remaining: number;
  signal?: AbortSignal;
  lifetime: AbortController;
};

// Share a scope across independently bundled server entries, not across requests.
const scopeKey = Symbol.for("hackerai.serviceQueryRecoveryScope.v1");
const runtime = globalThis as typeof globalThis & {
  [scopeKey]?: AsyncLocalStorage<Scope>;
};
const scopes = (runtime[scopeKey] ??= new AsyncLocalStorage<Scope>());

serviceQueryRecoveryRuntime[serviceQueryRecoveryKey] = () => {
  const scope = scopes.getStore();
  if (
    !scope ||
    scope.remaining === 0 ||
    scope.signal?.aborted ||
    scope.lifetime.signal.aborted
  )
    return;
  // Reserve synchronously before any await, including concurrent query failures.
  scope.remaining--;
  return {
    remaining: scope.remaining,
    signal: AbortSignal.any([
      scope.lifetime.signal,
      ...(scope.signal ? [scope.signal] : []),
      AbortSignal.timeout(1_500),
    ]),
  };
};

/** Two extra read attempts for the entire request/run, never per helper or tool. */
export async function runWithServiceQueryRecovery<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (scopes.getStore()) return operation();
  const scope: Scope = {
    remaining: 2,
    signal,
    lifetime: new AbortController(),
  };
  return scopes.run(scope, async () => {
    try {
      return await operation();
    } finally {
      // Detached reads must not start recovery after their owner has ended.
      scope.lifetime.abort();
    }
  });
}

export function withServiceQueryRecovery<
  Request extends { signal: AbortSignal },
  Result,
>(handler: (request: Request) => Promise<Result>) {
  return (request: Request): Promise<Result> =>
    runWithServiceQueryRecovery(() => handler(request), request.signal);
}
