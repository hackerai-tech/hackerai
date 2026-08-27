import type { Sandbox } from "@e2b/code-interpreter";

export const BASH_SANDBOX_AUTOPAUSE_TIMEOUT = 7 * 60 * 1000;
export const E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS = 2 * 60 * 1000;
export const E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;
export const E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS = 5 * 1000;

export type E2BSandboxLeaseRefreshSource =
  | "foreground_heartbeat"
  | "run_heartbeat"
  | "default_manager_cache"
  | "hybrid_manager_cache";

const logLeaseFailure = (
  event: string,
  sandbox: Sandbox,
  error: unknown,
  source?: E2BSandboxLeaseRefreshSource,
): void => {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event,
      service: "chat-handler",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
      request_id: process.env.VERCEL_REQUEST_ID ?? null,
      sandbox_id: sandbox.sandboxId,
      ...(source && { source }),
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

export const refreshE2BSandboxLease = async (
  sandbox: Sandbox,
): Promise<number> => {
  await sandbox.setTimeout(BASH_SANDBOX_AUTOPAUSE_TIMEOUT, {
    requestTimeoutMs: E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
  });
  return BASH_SANDBOX_AUTOPAUSE_TIMEOUT;
};

export const refreshE2BSandboxLeaseBestEffort = async (
  sandbox: Sandbox,
  options: {
    source: E2BSandboxLeaseRefreshSource;
    logFailure?: boolean;
  },
): Promise<boolean> => {
  try {
    await refreshE2BSandboxLease(sandbox);
    return true;
  } catch (error) {
    if (options.logFailure !== false) {
      logLeaseFailure(
        "e2b_sandbox_lease_refresh_failed",
        sandbox,
        error,
        options.source,
      );
    }
    return false;
  }
};

/**
 * Shortens only the remaining idle tail after a parent Agent run has settled.
 * A concurrent active run remains safe because its one-minute heartbeat
 * restores the normal seven-minute lease before this shorter timeout expires.
 */
export const releaseE2BSandboxIdleLeaseBestEffort = async (
  sandbox: Sandbox,
): Promise<boolean> => {
  try {
    await sandbox.setTimeout(E2B_SANDBOX_IDLE_RELEASE_TIMEOUT_MS, {
      requestTimeoutMs: E2B_SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    logLeaseFailure("e2b_sandbox_idle_lease_release_failed", sandbox, error);
    return false;
  }
};

export type E2BSandboxLeaseHeartbeat = {
  stop: () => Promise<void>;
};

/**
 * Starts a renewable lease heartbeat and returns an async stop operation that
 * waits for any refresh already in flight, preventing cleanup ordering races.
 */
export const startE2BSandboxLeaseHeartbeat = (
  getSandbox: () => Sandbox | null,
  source: Extract<
    E2BSandboxLeaseRefreshSource,
    "foreground_heartbeat" | "run_heartbeat"
  >,
): E2BSandboxLeaseHeartbeat => {
  let refreshInFlight: Promise<void> | null = null;
  let heartbeatFailureLogged = false;
  const refresh = (): void => {
    if (refreshInFlight) return;
    const sandbox = getSandbox();
    if (!sandbox) return;

    const refreshPromise = (async () => {
      const refreshed = await refreshE2BSandboxLeaseBestEffort(sandbox, {
        source,
        logFailure: !heartbeatFailureLogged,
      });
      heartbeatFailureLogged = !refreshed;
    })();
    refreshInFlight = refreshPromise;
    void refreshPromise.finally(() => {
      if (refreshInFlight === refreshPromise) refreshInFlight = null;
    });
  };

  const heartbeat = setInterval(() => {
    refresh();
  }, E2B_SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS);
  (
    heartbeat as ReturnType<typeof setInterval> & { unref?: () => void }
  ).unref?.();

  return {
    stop: async () => {
      clearInterval(heartbeat);
      await refreshInFlight;
    },
  };
};

/** Keeps an E2B lease renewable for exactly the lifetime of one operation. */
export const withE2BSandboxLeaseHeartbeat = async <T>(
  sandbox: Sandbox,
  operation: () => Promise<T>,
): Promise<T> => {
  const heartbeat = startE2BSandboxLeaseHeartbeat(
    () => sandbox,
    "foreground_heartbeat",
  );
  try {
    return await operation();
  } finally {
    await heartbeat.stop();
  }
};
