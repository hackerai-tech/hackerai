"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  WorkspaceRegionChoice,
  WorkspaceRegionView,
} from "@/lib/ai/tools/utils/cloud-workspace-selection";

type View = WorkspaceRegionView | { status: "loading" | "unconfirmed" };
const label = (region: string) =>
  region === "eu-central-1" ? "Europe workspace" : "US workspace";
const endpoint = "/api/sandbox/workspace-region";

async function request(
  signal: AbortSignal,
  init?: RequestInit,
): Promise<WorkspaceRegionView> {
  const response = await fetch(endpoint, {
    cache: "no-store",
    ...init,
    signal,
  });
  if (!response.ok) throw new Error("Workspace selection unavailable");
  const view = await response.json();
  if (
    view.status === "selected" &&
    ["us-east-1", "us-west-2", "eu-central-1"].includes(view.region)
  )
    return view;
  if (
    view.status === "selection_required" &&
    typeof view.token === "string" &&
    /^[a-f0-9]{64}$/.test(view.token) &&
    Array.isArray(view.choices) &&
    view.choices.length === 2 &&
    new Set(view.choices).size === 2 &&
    view.choices.every(
      (region: unknown) => region === "us-east-1" || region === "eu-central-1",
    )
  )
    return view;
  throw new Error("Workspace selection unavailable");
}

export function CloudWorkspaceRegionChoice({
  onRetry,
}: {
  onRetry: () => void;
}) {
  const titleId = useId();
  const [view, setView] = useState<View>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    void request(AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]))
      .then((next) => {
        if (!abort.signal.aborted) setView(next);
      })
      .catch(() => {
        if (!abort.signal.aborted) setView({ status: "unconfirmed" });
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (view.status === "selected") retryRef.current?.focus();
  }, [view.status]);

  async function act(region?: WorkspaceRegionChoice) {
    if (
      busyRef.current ||
      !controller.current ||
      controller.current.signal.aborted
    )
      return;
    if (region && view.status !== "selection_required") return;
    busyRef.current = true;
    setBusy(true);
    setNotSaved(false);
    const active = controller.current;
    const signal = () =>
      AbortSignal.any([active.signal, AbortSignal.timeout(20_000)]);
    try {
      let next: WorkspaceRegionView;
      if (region && view.status === "selection_required") {
        try {
          next = await request(signal(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ region, token: view.token }),
          });
        } catch {
          // Unknown outcomes are reconciled by one read, never a repeated POST.
          if (active.signal.aborted) return;
          next = await request(signal());
          if (!active.signal.aborted && next.status === "selection_required")
            setNotSaved(true);
        }
      } else next = await request(signal());
      if (!active.signal.aborted) setView(next);
    } catch {
      if (!active.signal.aborted) setView({ status: "unconfirmed" });
    } finally {
      busyRef.current = false;
      if (!active.signal.aborted) setBusy(false);
    }
  }
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="w-full rounded-lg border p-3 text-sm"
    >
      <p id={titleId} className="font-medium">
        Choose your cloud workspace
      </p>
      <p className="mt-1 text-muted-foreground">
        You have workspaces in the US and Europe. Choose the one you used most
        recently. Nothing is moved or deleted. Future tasks will use your
        choice; files in the other workspace stay there.
      </p>
      <p className="mt-1 text-muted-foreground">
        If you need files from the other workspace or are unsure which to
        choose,{" "}
        <a href="mailto:contact@hackerai.co" className="underline">
          contact support
        </a>
        .
      </p>
      <div role="status">
        {busy || view.status === "loading" ? (
          <p className="mt-2">Checking workspace selection…</p>
        ) : view.status === "selected" ? (
          <p className="mt-2">
            Using your {label(view.region)}. Retry when you’re ready.
          </p>
        ) : null}
      </div>
      {notSaved && !busy && (
        <p role="alert" className="mt-2 text-destructive">
          Your choice was not saved. Check the options below before choosing
          again.
        </p>
      )}
      {view.status === "unconfirmed" && !busy && (
        <p role="alert" className="mt-2 text-destructive">
          We couldn’t confirm your workspace selection. Wait for running tasks
          to finish, then check status. Contact support if this continues.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {view.status === "selection_required" &&
          view.choices.map((region) => (
            <Button
              key={region}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act(region)}
            >
              {label(region)}
            </Button>
          ))}
        {view.status === "unconfirmed" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act()}
          >
            Check status
          </Button>
        )}
        {view.status === "selected" && (
          <Button ref={retryRef} size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
