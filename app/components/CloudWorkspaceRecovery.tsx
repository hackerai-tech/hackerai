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
  reconnecting: "Reconnecting your workspace…",
};
export function CloudWorkspaceRecovery({
  surface = "cloud_connection_error",
}: {
  surface?: "cloud_connection_error" | "workspace_status";
}) {
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
        surface,
      });
    }
  }, [view, surface]);
  async function decide(decision: boolean | "reopen") {
    if (!view.token || busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/sandbox/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          decision === "reopen"
            ? { token: view.token, reopen: true }
            : { token: view.token, confirmed: decision },
        ),
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
  async function contactSupport() {
    const message = `My cloud workspace needs help recovering. Reference: ${view.reference ?? "unavailable"}. Status: ${view.status}.`;
    try {
      if (
        typeof (window as Window & { Intercom?: unknown }).Intercom !==
        "function"
      )
        throw new Error("Messenger unavailable");
      const intercom = await import("@intercom/messenger-js-sdk");
      // Opens a draft. Only the customer can send it.
      intercom.showNewMessage(message);
    } catch {
      window.open("https://help.hackerai.co/", "_blank", "noopener,noreferrer");
    }
  }
  if (view.status === "hidden") return null;
  return (
    <div
      className="mt-3 rounded-lg border p-4 text-sm"
      aria-label="Cloud workspace recovery"
    >
      <p className="font-medium mb-2">Cloud workspace</p>
      {view.status === "declined" ? (
        <>
          <p>Recovery is available whenever you’re ready.</p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void decide("reopen")}
          >
            Review recovery
          </Button>
        </>
      ) : view.status === "offered" ? (
        <>
          <p>
            Your cloud workspace couldn’t resume. Recovery may restart it from
            saved disk. A restart stops running processes and discards changes
            not saved to disk.
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
          Workspace ready. You can start a new request now. Previous tasks will
          not restart automatically.
        </p>
      ) : view.status === "support" ? (
        <>
          <p role="alert">
            Your cloud workspace needs support to recover safely. Contact
            support to review its status before trying recovery again.
          </p>
          {view.reference && (
            <p className="mt-2 text-muted-foreground">
              Reference: {view.reference}
            </p>
          )}
          <Button
            className="mt-3"
            size="sm"
            onClick={() => void contactSupport()}
          >
            Contact support
          </Button>
          <a
            className="ml-3 underline"
            href="https://help.hackerai.co/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Help center
          </a>
        </>
      ) : (
        <p role="status">
          {view.status === "waiting"
            ? "We’re waiting for current tasks and workspace connections to finish. We’ll check automatically and show recovery when it’s safe. This can take up to 15 minutes after the last activity."
            : (steps[view.step ?? "queued"] ??
              "Verifying your cloud workspace…")}{" "}
          You can leave this page and return to check progress.
        </p>
      )}
      {error && (
        <p className="mt-2" role="alert">
          We couldn’t check recovery status. Your confirmation won’t be sent
          again.
          <Button
            className="ml-2"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void refresh().catch(() => setError(true))}
          >
            Check status
          </Button>
        </p>
      )}
    </div>
  );
}
