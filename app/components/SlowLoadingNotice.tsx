"use client";

import { useEffect, useState } from "react";

/** Keep brief auth refreshes quiet, but never leave a failed load unexplained. */
export function SlowLoadingNotice({
  label = "Loading task…",
}: {
  label?: string;
}) {
  const [isSlow, setIsSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setIsSlow(true), 15_000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className="space-y-2 p-3 text-center text-sm text-muted-foreground"
      role="status"
    >
      <p>{isSlow ? "This is taking longer than expected." : label}</p>
      {isSlow && (
        <>
          <p>Check your connection, then reload to reconnect.</p>
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-foreground hover:bg-accent"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </>
      )}
    </div>
  );
}
