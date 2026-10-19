"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { RecoveryView } from "@/lib/cloud-recovery/service";
const steps: Record<string, string> = {
  queued: "Preparing recovery…",
  reboot_connected: "Checking terminal and file access…",
  inventory_observed: "Creating a backup…",
  backup_created: "Saving the recovered environment…",
  recovered_state_paused: "Checking persistence after restart…",
  normal_resume_verified: "Finishing verification…",
  final_state_paused: "Restoring access…",
};
export function CloudWorkspaceRecovery() {
  const [view, setView] = useState<RecoveryView>({ status: "hidden" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const exposed = useRef<string | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/sandbox/recovery", {
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error("Recovery status unavailable");
    const next = await response.json();
    if (!signal?.aborted) {
      setView(next);
      setError(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (view.status !== "recovering" && view.status !== "waiting") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(controller.signal);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [view.status, refresh]);
  useEffect(() => {
    if (
      view.status === "offered" &&
      view.token &&
      exposed.current !== view.token
    ) {
      exposed.current = view.token;
      captureAuthenticatedEvent("cloud_workspace_customer_recovery_exposed", {
        surface: "chat_error",
      });
    }
  }, [view]);
  async function decide(confirmed: boolean) {
    if (!view.token || busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/sandbox/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: view.token, confirmed }),
      });
      if (!response.ok) throw new Error("Recovery confirmation unavailable");
      setView(await response.json());
    } catch {
      // The server may have accepted consent. Read status; never repeat POST.
      setView({ status: "recovering", step: "queued" });
      setError(true);
      void refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  if (view.status === "hidden" || view.status === "declined") return null;
  return (
    <div
      className="mt-3 rounded-lg border p-4 text-sm"
      aria-label="Cloud workspace recovery"
    >
      {view.status === "offered" ? (
        <>
          <p>
            Your cloud workspace couldn’t resume. Recovering it will restart the
            environment from its saved disk. Running processes and unsaved
            changes may be lost.
          </p>
          <p className="mt-2 text-muted-foreground">
            Recovery will not continue your previous task. After recovery, start
            a new request.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
              {busy ? "Submitting…" : "Recover workspace"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Not now
            </Button>
          </div>
        </>
      ) : view.status === "recovered" ? (
        <p role="status">
          Your workspace passed recovery checks. Reload this page, then start a
          new request. Previous tasks will not restart automatically.
        </p>
      ) : view.status === "support" ? (
        <p role="alert">
          Your cloud workspace needs support to recover safely. Contact support
          before trying recovery again. We have not created a replacement
          workspace.
        </p>
      ) : (
        <p role="status">
          {view.status === "waiting"
            ? "Recovery is waiting for workspace activity to stop. Stop active tasks and close workspace connections. Recent activity can take up to 15 minutes to settle."
            : (steps[view.step ?? "queued"] ??
              "Verifying your cloud workspace…")}{" "}
          You can leave this page and return to check progress.
        </p>
      )}
      {error && (
        <p className="mt-2" role="alert">
          Recovery status could not be checked. We will keep checking; do not
          submit another recovery.
        </p>
      )}
    </div>
  );
}
