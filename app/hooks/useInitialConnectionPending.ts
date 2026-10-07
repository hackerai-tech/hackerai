"use client";

import { useEffect, useState } from "react";

const INITIAL_EMPTY_CONNECTION_GRACE_MS = 750;

/**
 * Keeps the initial loading state stable when the first resolved connection
 * snapshot is briefly empty. Later disconnects are never delayed.
 */
export function useInitialConnectionPending({
  connected,
  connectionCount,
  preference,
}: {
  connected: boolean;
  connectionCount: number | undefined;
  preference: string;
}): boolean {
  const [hasObservedLoading] = useState(connectionCount === undefined);
  const [settledPreference, setSettledPreference] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (preference === "e2b") return;

    if (connected) {
      if (settledPreference === preference) return;
      const timeout = window.setTimeout(() => {
        setSettledPreference(preference);
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    if (
      connectionCount === undefined ||
      connectionCount > 0 ||
      !hasObservedLoading ||
      settledPreference === preference
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSettledPreference(preference);
    }, INITIAL_EMPTY_CONNECTION_GRACE_MS);
    return () => window.clearTimeout(timeout);
  }, [
    connected,
    connectionCount,
    hasObservedLoading,
    preference,
    settledPreference,
  ]);

  return (
    preference !== "e2b" &&
    !connected &&
    (connectionCount === undefined ||
      (connectionCount === 0 &&
        hasObservedLoading &&
        settledPreference !== preference))
  );
}
