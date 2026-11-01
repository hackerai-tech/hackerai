"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type {
  CloudWorkspaceOption,
  CloudWorkspaceOptions,
} from "@/lib/ai/tools/utils/cloud-workspace-options";

type View = CloudWorkspaceOptions | { status: "loading" | "unavailable" };
const endpoint = "/api/sandbox/workspaces";
const changedEvent = "hackerai:cloud-workspace-selected";
const regionLabel = (region: string) =>
  region === "eu-central-1" ? "Europe workspace" : "US workspace";
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validRegion = (value: unknown) =>
  ["us-east-1", "us-west-2", "eu-central-1"].includes(String(value));
function validChoice(choice: CloudWorkspaceOption) {
  return (
    choice &&
    validId(choice.id) &&
    validRegion(choice.region) &&
    (choice.lastStartedAt === null ||
      (typeof choice.lastStartedAt === "string" &&
        Number.isFinite(Date.parse(choice.lastStartedAt))))
  );
}
async function request(
  signal: AbortSignal,
  manage: boolean,
  init?: RequestInit,
): Promise<CloudWorkspaceOptions> {
  const response = await fetch(endpoint + (manage ? "?manage=1" : ""), {
    cache: "no-store",
    ...init,
    signal,
  });
  if (!response.ok) throw new Error("Workspace selection unavailable");
  const view = await response.json();
  if (
    view.status === "selected" &&
    validId(view.id) &&
    validRegion(view.region)
  )
    return view;
  if (
    view.status === "selection_required" &&
    typeof view.token === "string" &&
    /^[a-f0-9]{64}$/.test(view.token) &&
    Array.isArray(view.choices) &&
    view.choices.length > 0 &&
    view.choices.length <= 100 &&
    view.choices.every(validChoice) &&
    new Set(view.choices.map((choice: CloudWorkspaceOption) => choice.id))
      .size === view.choices.length &&
    (view.currentId === undefined ||
      view.choices.some(
        (choice: CloudWorkspaceOption) => choice.id === view.currentId,
      ))
  )
    return view;
  if (
    view.status === "waiting" &&
    ["active_tasks", "recent_activity", "running_workspace"].includes(
      view.reason,
    )
  )
    return view;
  if (
    view.status === "protected" &&
    ["recovery", "provisioning", "cleanup", "identity"].includes(view.reason)
  )
    return view;
  if (view.status === "empty") return view;
  throw new Error("Workspace selection unavailable");
}
function shortId(id: string, choices: CloudWorkspaceOption[]) {
  let length = 6;
  while (
    length < id.length &&
    choices.some(
      (choice) =>
        choice.id !== id && choice.id.slice(-length) === id.slice(-length),
    )
  )
    length++;
  return id.slice(-length);
}
function started(value: string | null) {
  return value
    ? `Last started ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))}`
    : "Last-started time unavailable";
}

export function CloudWorkspaceRegionChoice({
  onRetry,
  manage = false,
}: {
  onRetry?: () => void;
  manage?: boolean;
}) {
  const titleId = useId();
  const [view, setView] = useState<View>({ status: "loading" });
  const viewRef = useRef<View>(view);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const autoChecks = useRef(0);
  const managing = useRef(manage);
  const cardRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const focusAfterAction = useRef(false);
  const exposed = useRef<string | null>(null);
  const apply = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
    setDraft(
      next.status === "selection_required" ? (next.currentId ?? null) : null,
    );
  }, []);
  const act = useCallback(
    async (id?: string, showChoices = managing.current, automatic = false) => {
      const active = controller.current;
      if (busyRef.current || !active || active.signal.aborted) return;
      const previous = viewRef.current;
      if (id && previous.status !== "selection_required") return;
      managing.current = id ? false : showChoices;
      busyRef.current = true;
      if (!automatic) setBusy(true);
      setNotice(null);
      if (!automatic) autoChecks.current = 0;
      const current = ++generation.current;
      const signal = () =>
        AbortSignal.any([active.signal, AbortSignal.timeout(20_000)]);
      try {
        let next: CloudWorkspaceOptions;
        if (id && previous.status === "selection_required") {
          try {
            next = await request(signal(), false, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ workspaceId: id, token: previous.token }),
            });
          } catch {
            if (active.signal.aborted) return;
            // A lost write response is reconciled with a read, never another POST.
            next = await request(signal(), false);
          }
          if (next.status !== "selected" || next.id !== id) {
            setNotice(
              next.status === "selected"
                ? "A different workspace is currently selected. Check the saved workspace below before retrying."
                : "Your choice wasn’t confirmed. Check the current options before choosing again.",
            );
          } else {
            captureAuthenticatedEvent("cloud_workspace_choice_saved", {
              surface: manage ? "workspace_dialog" : "workspace_error",
              changed_existing: previous.currentId !== undefined,
            });
            window.dispatchEvent(new Event(changedEvent));
          }
        } else next = await request(signal(), showChoices);
        if (!active.signal.aborted && current === generation.current)
          apply(next);
      } catch {
        if (!active.signal.aborted && current === generation.current) {
          apply({ status: "unavailable" });
          if (id)
            setNotice(
              "We couldn’t confirm whether your choice was saved. Check status before choosing again.",
            );
        }
      } finally {
        busyRef.current = false;
        if (!active.signal.aborted && current === generation.current) {
          focusAfterAction.current = !automatic;
          setBusy(false);
        }
      }
    },
    [apply, manage],
  );
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    managing.current = manage;
    const current = ++generation.current;
    void request(
      AbortSignal.any([active.signal, AbortSignal.timeout(20_000)]),
      manage,
    )
      .then((next) => {
        if (!active.signal.aborted && current === generation.current)
          apply(next);
      })
      .catch(() => {
        if (!active.signal.aborted && current === generation.current)
          apply({ status: "unavailable" });
      });
    return () => {
      active.abort();
    };
  }, [apply, manage]);
  useEffect(() => {
    const refresh = () => void act(undefined, false);
    window.addEventListener(changedEvent, refresh);
    return () => window.removeEventListener(changedEvent, refresh);
  }, [act]);
  useEffect(() => {
    if (view.status === "loading") return;
    const reason =
      view.status === "waiting" || view.status === "protected"
        ? view.reason
        : undefined;
    const count =
      view.status === "selection_required" ? view.choices.length : 0;
    const key = `${view.status}:${reason ?? ""}:${count}`;
    if (exposed.current === key) return;
    exposed.current = key;
    captureAuthenticatedEvent("cloud_workspace_options_viewed", {
      surface: manage ? "workspace_dialog" : "workspace_error",
      status: view.status,
      ...(reason ? { reason } : {}),
      choice_count: count,
    });
  }, [manage, view]);
  useEffect(() => {
    if (view.status !== "waiting" || autoChecks.current >= 30) return;
    let due = false;
    const check = () => {
      if (!due || document.visibilityState === "hidden") return;
      due = false;
      autoChecks.current++;
      void act(undefined, undefined, true);
    };
    const timer = setTimeout(() => {
      due = true;
      check();
    }, 30_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [act, view]);
  useEffect(() => {
    if (!busy && focusAfterAction.current) {
      focusAfterAction.current = false;
      if (
        document.activeElement === document.body ||
        cardRef.current?.contains(document.activeElement)
      )
        (view.status === "selected"
          ? (retryRef.current ?? cardRef.current)
          : cardRef.current
        )?.focus();
    }
  }, [busy, view]);
  const choices =
    view.status === "selection_required"
      ? [...view.choices].sort(
          (a, b) =>
            Number(b.id === view.currentId) - Number(a.id === view.currentId) ||
            (Date.parse(b.lastStartedAt ?? "") || 0) -
              (Date.parse(a.lastStartedAt ?? "") || 0) ||
            a.id.localeCompare(b.id),
        )
      : [];
  const waitingText =
    view.status === "waiting"
      ? {
          active_tasks:
            "A task is still running. You can switch workspaces after it finishes or you stop it in chat.",
          recent_activity:
            "Your workspace was active recently. Switching becomes available after 15 minutes without workspace activity.",
          running_workspace:
            "A workspace is still running. You can switch after it pauses automatically.",
        }[view.reason]
      : null;
  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-labelledby={manage ? undefined : titleId}
      aria-label={manage ? "Cloud workspace status" : undefined}
      className={
        manage ? "mt-4 w-full text-sm" : "w-full rounded-lg border p-3 text-sm"
      }
    >
      {!manage && (
        <p id={titleId} className="font-medium">
          {view.status === "selection_required"
            ? "Choose your cloud workspace"
            : "Cloud workspace"}
        </p>
      )}
      {view.status === "selection_required" && (
        <>
          <p className="mt-1 text-muted-foreground">
            Choose which workspace future cloud tasks use. You can switch again
            when your tasks and connections have finished.
          </p>
          <fieldset
            disabled={busy}
            className="mt-3 max-h-72 space-y-2 overflow-y-auto p-0.5"
          >
            <legend className="sr-only">Saved cloud workspaces</legend>
            {choices.map((choice) => (
              <label
                key={choice.id}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <input
                  type="radio"
                  name={titleId}
                  value={choice.id}
                  checked={draft === choice.id}
                  onChange={() => setDraft(choice.id)}
                  className="mt-1 accent-current"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {regionLabel(choice.region)}
                    {choice.id === view.currentId && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal">
                        Current
                      </span>
                    )}
                  </span>
                  <span
                    className="block break-words text-xs text-muted-foreground"
                    title={choice.id}
                  >
                    ID {shortId(choice.id, choices)} ·{" "}
                    {started(choice.lastStartedAt)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="mt-2 text-xs text-muted-foreground">
            The last-started time doesn’t tell you which workspace has your
            files.
          </p>
        </>
      )}
      <div role="status">
        {(busy || view.status === "loading") && (
          <p className="mt-2">Checking your workspaces…</p>
        )}
        {!busy && view.status === "selected" && (
          <p className="mt-2">
            Using your {regionLabel(view.region)} · {view.id.slice(-6)}.{" "}
            {onRetry
              ? "Retry when you’re ready."
              : "Future cloud tasks will use this workspace."}
          </p>
        )}
        {!busy && waitingText && (
          <p className="mt-2">
            {waitingText}{" "}
            {autoChecks.current < 30
              ? "We’ll check again while this stays open."
              : "Use Check status to check again."}
          </p>
        )}
        {!busy && view.status === "empty" && (
          <p className="mt-2">
            No saved cloud workspaces were found. Your next cloud task will
            create your first workspace.
          </p>
        )}
        {!busy && view.status === "protected" && (
          <p className="mt-2">
            {view.reason === "provisioning"
              ? "An earlier workspace setup hasn’t been confirmed yet."
              : view.reason === "recovery"
                ? "Your workspace is protected while its recovery status is checked. Select Cloud in chat to review recovery options."
                : "Your workspace identity needs verification before it can be changed."}{" "}
            Check status to try again. If this continues,{" "}
            <a href="mailto:contact@hackerai.co" className="underline">
              contact support
            </a>
            .
          </p>
        )}
      </div>
      {!busy && view.status === "unavailable" && (
        <p role="alert" className="mt-2 text-destructive">
          {notice ??
            "We couldn’t check your saved workspaces. Your selection hasn’t been changed by this check. Try again in a few minutes."}
        </p>
      )}
      {!busy && notice && view.status !== "unavailable" && (
        <p role="alert" className="mt-2 text-destructive">
          {notice}
        </p>
      )}
      {view.status !== "empty" && (
        <p className="mt-2 text-xs text-muted-foreground">
          All saved workspaces and files stay where they are. Switching does not
          move, merge, or delete files.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {view.status === "selection_required" && (
          <Button
            size="sm"
            className="min-h-11"
            disabled={busy || !draft || draft === view.currentId}
            onClick={() => void act(draft!)}
          >
            Use this workspace
          </Button>
        )}
        {onRetry && (view.status === "selected" || view.status === "empty") && (
          <Button
            ref={retryRef}
            size="sm"
            className="min-h-11"
            disabled={busy}
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
        {view.status === "selected" && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => void act(undefined, true)}
          >
            Choose another workspace
          </Button>
        )}
        {["waiting", "unavailable", "protected"].includes(view.status) && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => void act()}
          >
            Check status
          </Button>
        )}
      </div>
    </div>
  );
}
