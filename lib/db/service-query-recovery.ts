// Convex also analyzes service-client. Keep the Node request/run scope behind
// this bridge, as with service-transport-observation.
export const serviceQueryRecoveryKey = Symbol.for(
  "hackerai.serviceQueryRecovery.v1",
);

export interface ServiceQueryRecoveryAttempt {
  signal: AbortSignal;
  remaining: number;
}

export const serviceQueryRecoveryRuntime = globalThis as typeof globalThis & {
  [serviceQueryRecoveryKey]?: () => ServiceQueryRecoveryAttempt | undefined;
};

const recoverableQueries = new Set([
  "agentGoals:getForBackend",
  "localSandbox:listConnectionsForBackend",
  "localSandbox:resolveEnvironmentPreferenceForBackend",
  "browserHandoffs:getForBackend",
  "browserHandoffs:getExitNotesForBackend",
  "userSuspensions:getActiveByUser",
]);

export function reserveServiceQueryRecovery(
  url: URL,
  functionName: string | undefined,
  error: unknown,
  statusCode: number | undefined,
): ServiceQueryRecoveryAttempt | undefined {
  // HTTP/application/auth errors and every mutation/action remain unchanged.
  // A body reset after HTTP 200 is eligible; a failed 4xx/5xx body is not.
  if (
    url.pathname !== "/api/query" ||
    !functionName ||
    !recoverableQueries.has(functionName) ||
    (statusCode !== undefined && statusCode !== 200) ||
    !(error instanceof TypeError) ||
    !["fetch failed", "terminated"].includes(error.message)
  )
    return;
  const cause = error.cause as { code?: unknown } | undefined;
  if (cause?.code !== "ECONNRESET" && cause?.code !== "UND_ERR_SOCKET") return;
  return serviceQueryRecoveryRuntime[serviceQueryRecoveryKey]?.();
}
