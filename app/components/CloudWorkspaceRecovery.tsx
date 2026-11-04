"use client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { RecoveryView } from "@/lib/cloud-recovery/service";
import { CloudRecoveryAdmissionContext } from "@/app/hooks/useCloudRecoveryAdmission";
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
  onSettled,
}: {
  surface?: "cloud_connection_error" | "workspace_status" | "workspace_dialog";
  onSettled?: () => void;
}) {
  const admission = useContext(CloudRecoveryAdmissionContext);
  const beginRead = admission?.beginRead;
  const finishRead = admission?.finishRead;
  const channel = useRef<BroadcastChannel | null>(null);
  const wasRecovering = useRef<boolean | null>(null);
  const notifyChange = useCallback(() => {
    try {
      channel.current?.postMessage("changed");
    } catch {
      // Cross-tab hints must never change consent or recovery outcomes.
    }
  }, []);
  const [view, setView] = useState<RecoveryView>({ status: "hidden" });
  const [observedRecovery, setObservedRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [checked, setChecked] = useState(false);
  const [checksStopped, setChecksStopped] = useState(false);
  const checks = useRef(0);
  const exposed = useRef<string | null>(null);
  const statusReadGeneration = useRef(0);
  const updateView = useCallback(
    (next: RecoveryView) => {
      if (
        next.status === "offered" ||
        next.status === "declined" ||
        next.status === "waiting" ||
        next.status === "recovering"
      )
        setObservedRecovery(true);
      setView(next);
      const recovering = next.status === "recovering";
      if (wasRecovering.current !== recovering) {
        if (wasRecovering.current !== null || recovering) notifyChange();
        wasRecovering.current = recovering;
      }
      if (next.status === "hidden" || next.status === "recovered")
        onSettled?.();
    },
    [onSettled, notifyChange],
  );
  // Durable recovery receipts belong to the workspace, not the current chat.
  // Announce completion only if this mount actually displayed the incident.
  const hidden =
    view.status === "hidden" ||
    (view.status === "recovered" && !observedRecovery);
  const refresh = useCallback(
    async (signal?: AbortSignal, reportError = true) => {
      const generation = ++statusReadGeneration.current;
      const read = beginRead?.();
      const isCurrent = () =>
        !signal?.aborted && generation === statusReadGeneration.current;
      try {
        const response = await fetch("/api/sandbox/recovery", {
          cache: "no-store",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
            : AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error("Recovery status unavailable");
        const next = await response.json();
        if (isCurrent()) {
          if (read !== undefined) finishRead?.(read, next.status);
          setChecked(true);
          updateView(next);
          setError(false);
        }
      } catch {
        if (isCurrent() && read !== undefined) finishRead?.(read);
        if (isCurrent() && reportError) {
          setChecked(true);
          setError(true);
        }
      }
    },
    [updateView, beginRead, finishRead],
  );
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    let current: BroadcastChannel;
    try {
      current = new BroadcastChannel("cloud-workspace-recovery");
    } catch {
      return;
    }
    channel.current = current;
    current.onmessage = (event) => {
      if (event.data === "changed") void refresh();
    };
    return () => {
      channel.current = null;
      current.close();
    };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal, surface !== "workspace_status");
    return () => controller.abort();
  }, [refresh, surface]);
  useEffect(() => {
    // Another tab can confirm an offered or deferred recovery. Keep reading
    // server state until it settles, without submitting consent from this tab.
    // Abort older reads while a local decision is being submitted.
    if (busy || checksStopped) return;
    // The acquisition deadline can close its stream before failure persistence
    // finishes. Reconcile that event independently, with six reads and backoff.
    const checkingRecordedFailure = hidden && surface !== "workspace_status";
    if (
      view.status !== "recovering" &&
      view.status !== "waiting" &&
      view.status !== "offered" &&
      view.status !== "declined" &&
      view.status !== "support" &&
      !checkingRecordedFailure
    )
      return;
    const controller = new AbortController();
    let hiddenChecks = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => void poll(), 30000);
        return;
      }
      if (checks.current >= 42) {
        setChecksStopped(true);
        return;
      }
      checks.current += 1;
      await refresh(controller.signal);
      if (
        !controller.signal.aborted &&
        checks.current < 42 &&
        (!checkingRecordedFailure || ++hiddenChecks < 6)
      )
        timer = setTimeout(
          () => void poll(),
          checkingRecordedFailure
            ? Math.min(5000 * 2 ** hiddenChecks, 30000)
            : checks.current < 12
              ? 5000
              : 30000,
        );
      else if (!controller.signal.aborted) setChecksStopped(true);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [view.status, hidden, busy, refresh, surface, checksStopped]);
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
    const finishConfirmation =
      decision === true ? admission?.beginConfirmation() : undefined;
    if (decision === true && admission && !finishConfirmation) return;
    checks.current = 0;
    setChecksStopped(false);
    statusReadGeneration.current += 1;
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
      const next = await response.json();
      finishConfirmation?.(next.status);
      updateView(next);
    } catch {
      finishConfirmation?.("recovering");
      // The server may have accepted consent. Read status; never repeat POST.
      updateView({ status: "recovering", step: "queued" });
      setError(true);
      void refresh();
    } finally {
      if (decision === true) notifyChange();
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
  async function checkStatus() {
    checks.current = 0;
    setChecksStopped(false);
    await refresh();
  }
  if (hidden && !error && surface !== "workspace_dialog") return null;
  return (
    <div
      className="mt-3 rounded-lg border p-4 text-sm"
      role="group"
      aria-label="Cloud workspace recovery"
    >
      <p className="font-medium mb-2">Cloud workspace</p>
      {hidden ? (
        surface === "workspace_dialog" && !error ? (
          <p role="status">
            {checked
              ? "No recovery action is available yet. Checking status does not restart or change your workspace."
              : "Checking recovery status…"}
          </p>
        ) : null
      ) : view.status === "declined" ? (
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
            Your cloud workspace couldn’t resume. Recovery may restart this same
            workspace in its current region from saved disk. A restart stops
            running processes and discards writes not yet flushed to disk. Other
            saved workspaces are kept.
          </p>
          <p className="mt-2 text-muted-foreground">
            Recovery will not continue your previous task. After recovery, start
            a new request.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              size="sm"
              disabled={busy}
              onClick={() => void decide(true)}
            >
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
            ? "We’re checking whether recovery is safe. Active tasks, recent connections, or a busy provider can delay recovery. We’ll check automatically. The safety wait can last 15 minutes after the last activity."
            : (steps[view.step ?? "queued"] ??
              "Verifying your cloud workspace…")}{" "}
          You can leave this page and return to check progress.
        </p>
      )}
      {checksStopped && (
        <p className="mt-2 text-muted-foreground" role="status">
          Automatic checks have stopped. Check status for the latest update.
        </p>
      )}
      {!error &&
        (surface === "workspace_dialog" ||
          checksStopped ||
          view.status === "support") && (
          <Button
            className="mt-3 min-h-11"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void checkStatus()}
          >
            Check status
          </Button>
        )}
      {error && (
        <p className="mt-2" role="alert">
          {hidden
            ? "Workspace status couldn’t be checked. Try again when your connection returns."
            : "We couldn’t check recovery status. Your confirmation won’t be sent again."}
          <Button
            className="ml-2"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void checkStatus()}
          >
            Check status
          </Button>
        </p>
      )}
    </div>
  );
}
