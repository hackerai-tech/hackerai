"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Minimize2,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { UIMessage } from "ai";

import { api } from "@/convex/_generated/api";
import type { SidebarSubagents } from "@/types/chat";
import { MessagePartHandler } from "./MessagePartHandler";
import { useSubagentRealtime } from "@/app/hooks/useSubagentRealtime";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";

type ChildStatus =
  | "queued"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "canceled"
  | "timed_out";

type ChildSummary = {
  subagent_id: string;
  parent_trigger_run_id: string;
  parent_tool_call_id: string;
  trigger_run_id?: string;
  status: ChildStatus;
  candidate: { title: string; affected_asset: string };
  summary?: string;
  verdict?: "confirmed" | "rejected" | "inconclusive";
  confidence?: "low" | "medium" | "high";
  failure_code?: string;
  failure_reason?: string;
  cancel_reason?: string;
  report_id?: string;
  cost_dollars?: number;
  step_count?: number;
  created_at: number;
  started_at?: number;
  completed_at?: number;
};

const ACTIVE_STATUSES = new Set<ChildStatus>([
  "queued",
  "running",
  "finalizing",
]);

const isActive = (status: ChildStatus) => ACTIVE_STATUSES.has(status);

const formatElapsed = (start: number, end: number): string => {
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
};

const statusLabel = (child: ChildSummary): string => {
  if (child.status === "completed") {
    return child.verdict === "confirmed"
      ? "Confirmed"
      : child.verdict === "rejected"
        ? "Rejected"
        : "Inconclusive";
  }
  if (child.status === "timed_out") return "Timed out";
  return child.status.charAt(0).toUpperCase() + child.status.slice(1);
};

const StatusIcon = ({ child }: { child: ChildSummary }) => {
  if (isActive(child.status)) {
    return <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />;
  }
  if (child.status === "completed" && child.verdict === "confirmed") {
    return <ShieldCheck className="h-4 w-4 text-emerald-500" aria-hidden />;
  }
  if (child.status === "completed") {
    return (
      <CheckCircle2 className="h-4 w-4 text-muted-foreground" aria-hidden />
    );
  }
  if (child.status === "canceled") {
    return <Ban className="h-4 w-4 text-muted-foreground" aria-hidden />;
  }
  return <CircleAlert className="h-4 w-4 text-destructive" aria-hidden />;
};

const ChildRow = ({
  child,
  now,
  onOpen,
}: {
  child: ChildSummary;
  now: number;
  onOpen: () => void;
}) => (
  <button
    type="button"
    onClick={onOpen}
    className="group flex w-full items-center gap-3 rounded-xl border border-border/40 bg-muted/15 px-3 py-3 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    aria-label={`Open ${child.candidate.title}, ${statusLabel(child)}`}
  >
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/50">
      <StatusIcon child={child} />
    </div>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium text-foreground">
        {child.candidate.title}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{statusLabel(child)}</span>
        <span aria-hidden>·</span>
        <span>
          {formatElapsed(
            child.started_at ?? child.created_at,
            child.completed_at ?? now,
          )}
        </span>
      </div>
      {child.summary && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {child.summary}
        </p>
      )}
    </div>
    <ChevronRight
      className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      aria-hidden
    />
  </button>
);

const Transcript = memo(function Transcript({
  child,
}: {
  child: ChildSummary;
}) {
  const persisted = useQuery(api.subagents.getMessagesOwned, {
    subagentId: child.subagent_id,
  });
  const active = isActive(child.status);
  const hasPersistedAssistant = persisted?.some(
    (message) => message.role === "assistant",
  );
  const {
    message: liveMessage,
    state,
    retry,
  } = useSubagentRealtime({
    subagentId: child.subagent_id,
    enabled:
      !!child.trigger_run_id &&
      (active || (persisted !== undefined && !hasPersistedAssistant)),
  });

  const messages = useMemo(() => {
    const saved = (persisted ?? []).map((message): UIMessage => ({
      id: `${child.subagent_id}-${message.sequence}`,
      role: message.role,
      parts: message.parts as UIMessage["parts"],
    }));
    return liveMessage && !hasPersistedAssistant
      ? [...saved, liveMessage]
      : saved;
  }, [child.subagent_id, hasPersistedAssistant, liveMessage, persisted]);

  if (persisted === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading transcript…
      </div>
    );
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
      aria-live={active ? "polite" : "off"}
      aria-label="Subagent transcript and tool activity"
    >
      {messages.length === 0 && state !== "error" && (
        <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {(active || state === "connecting") && (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          )}
          {state === "connecting"
            ? "Connecting to activity…"
            : active
              ? "Waiting for activity…"
              : "No transcript activity was persisted."}
        </div>
      )}
      {state === "error" && active && (
        <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="text-destructive">Live activity disconnected.</p>
          <button
            type="button"
            onClick={retry}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Reconnect
          </button>
        </div>
      )}
      {state === "error" && !active && messages.length === 0 && (
        <div className="mb-3 rounded-lg border border-border/50 bg-muted/20 p-3 text-sm text-muted-foreground">
          Transcript activity is unavailable. The final status above is still
          authoritative.
        </div>
      )}
      <div className="space-y-4">
        {messages.map((message) => (
          <section key={message.id} className="min-w-0">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {message.role === "assistant" ? "Validator" : "Validation brief"}
            </div>
            <div className="min-w-0 space-y-2 overflow-hidden text-sm text-foreground">
              {message.parts.map((part, partIndex) => (
                <MessagePartHandler
                  key={`${message.id}-${partIndex}`}
                  message={message}
                  part={part}
                  partIndex={partIndex}
                  status={active ? "streaming" : "ready"}
                  isLastMessage={message === messages[messages.length - 1]}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
});

export const SubagentsSidebar = ({
  content,
  closeSidebar,
}: {
  content: SidebarSubagents;
  closeSidebar: () => void;
}) => {
  const runs = useQuery(api.subagents.listForParentMessage, {
    parentMessageId: content.parentMessageId,
  }) as ChildSummary[] | undefined;
  const [selectedId, setSelectedId] = useState<string | null>(
    content.selectedSubagentId ?? null,
  );
  const [now, setNow] = useState(Date.now());
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const openedChildren = useRef(new Set<string>());
  const selectedForCleanup = useRef<ChildSummary | null>(null);
  const selectedOpenedAt = useRef<{ id: string; at: number } | null>(null);

  const selected =
    runs?.find((child) => child.subagent_id === selectedId) ?? null;
  selectedForCleanup.current = selected;
  const active = runs?.filter((child) => isActive(child.status)) ?? [];
  const done = runs?.filter((child) => !isActive(child.status)) ?? [];

  useEffect(() => {
    captureAuthenticatedEvent("subagent_sidebar_opened", {
      parent_message_id: content.parentMessageId,
      profile: "security_validation",
      view: "list",
    });
    return () => {
      const child = selectedForCleanup.current;
      if (child && isActive(child.status)) {
        const openedAt = selectedOpenedAt.current;
        captureAuthenticatedEvent("subagent_abandoned", {
          subagent_id: child.subagent_id,
          parent_trigger_run_id: child.parent_trigger_run_id,
          profile: "security_validation",
          status: child.status,
          open_duration_ms:
            Date.now() -
            (openedAt?.id === child.subagent_id
              ? openedAt.at
              : child.created_at),
        });
      }
    };
  }, [content.parentMessageId]);

  useEffect(() => {
    if (!selected) return;
    selectedOpenedAt.current = { id: selected.subagent_id, at: Date.now() };
    if (openedChildren.current.has(selected.subagent_id)) return;
    openedChildren.current.add(selected.subagent_id);
    captureAuthenticatedEvent("subagent_opened", {
      subagent_id: selected.subagent_id,
      parent_trigger_run_id: selected.parent_trigger_run_id,
      profile: "security_validation",
      status: selected.status,
      open_latency_ms: Date.now() - selected.created_at,
    });
  }, [selected]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selectedId) {
        setSelectedId(null);
      } else {
        closeSidebar();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeSidebar, selectedId]);

  useEffect(() => {
    if (!runs?.some((child) => isActive(child.status))) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [runs]);

  const cancelSelected = async () => {
    if (!selected || !isActive(selected.status)) return;
    setCanceling(true);
    setCancelError(null);
    try {
      const response = await fetch(
        `/api/subagents/${encodeURIComponent(selected.subagent_id)}/cancel`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error("Cancel failed");
    } catch {
      setCancelError("Could not cancel this validation. Try again.");
    } finally {
      setCanceling(false);
    }
  };

  return (
    <aside
      className="fixed left-0 top-0 z-50 h-full w-full shrink-0 desktop:relative desktop:left-auto desktop:top-auto desktop:mr-4 desktop:h-full"
      aria-label="Subagents"
    >
      <div className="h-full w-full">
        <div className="flex h-full w-full rounded-[22px] border border-border/20 bg-background shadow-[0px_0px_8px_0px_rgba(0,0,0,0.02)] dark:border-border">
          <div className="flex h-full min-w-0 flex-1 flex-col p-4">
            <header className="flex items-center gap-2">
              {selected && (
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Back to subagent list"
                >
                  <ArrowLeft className="h-5 w-5" aria-hidden />
                </button>
              )}
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Users className="h-5 w-5 shrink-0" aria-hidden />
                <h2 className="truncate text-lg font-semibold">
                  {selected ? selected.candidate.title : "Subagents"}
                </h2>
              </div>
              <button
                type="button"
                onClick={closeSidebar}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Minimize subagents sidebar"
              >
                <Minimize2 className="h-5 w-5" aria-hidden />
              </button>
            </header>

            {!selected ? (
              <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
                {runs === undefined ? (
                  <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle
                      className="h-4 w-4 animate-spin"
                      aria-hidden
                    />
                    Loading subagents…
                  </div>
                ) : runs.length === 0 ? (
                  <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border/60 px-6 text-center">
                    <Users
                      className="mb-2 h-6 w-6 text-muted-foreground"
                      aria-hidden
                    />
                    <p className="text-sm font-medium">Preparing validation</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The child will appear here when its durable run is
                      reserved.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    <section aria-labelledby="active-subagents-heading">
                      <div className="mb-2 flex items-center justify-between">
                        <h3
                          id="active-subagents-heading"
                          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                        >
                          Active
                        </h3>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {active.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {active.length > 0 ? (
                          active.map((child) => (
                            <ChildRow
                              key={child.subagent_id}
                              child={child}
                              now={now}
                              onOpen={() => setSelectedId(child.subagent_id)}
                            />
                          ))
                        ) : (
                          <p className="rounded-lg border border-dashed border-border/50 px-3 py-4 text-center text-xs text-muted-foreground">
                            No active children
                          </p>
                        )}
                      </div>
                    </section>
                    <section aria-labelledby="done-subagents-heading">
                      <div className="mb-2 flex items-center justify-between">
                        <h3
                          id="done-subagents-heading"
                          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                        >
                          Done
                        </h3>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {done.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {done.length > 0 ? (
                          done.map((child) => (
                            <ChildRow
                              key={child.subagent_id}
                              child={child}
                              now={now}
                              onOpen={() => setSelectedId(child.subagent_id)}
                            />
                          ))
                        ) : (
                          <p className="rounded-lg border border-dashed border-border/50 px-3 py-4 text-center text-xs text-muted-foreground">
                            Completed children will appear here
                          </p>
                        )}
                      </div>
                    </section>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/40 bg-muted/10">
                <div className="border-b border-border/40 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      <StatusIcon child={selected} />
                      <span className="font-medium">
                        {statusLabel(selected)}
                      </span>
                      <span className="text-muted-foreground">·</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatElapsed(
                          selected.started_at ?? selected.created_at,
                          selected.completed_at ?? now,
                        )}
                      </span>
                    </div>
                    {isActive(selected.status) && (
                      <button
                        type="button"
                        onClick={cancelSelected}
                        disabled={canceling}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Ban className="h-3.5 w-3.5" aria-hidden />
                        {canceling ? "Canceling…" : "Cancel"}
                      </button>
                    )}
                  </div>
                  <p
                    className="mt-1 truncate text-xs text-muted-foreground"
                    title={selected.candidate.affected_asset}
                  >
                    {selected.candidate.affected_asset}
                  </p>
                  {selected.summary && (
                    <p className="mt-2 text-sm text-foreground">
                      {selected.summary}
                    </p>
                  )}
                  {selected.report_id && (
                    <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                      Report saved as {selected.report_id}
                    </p>
                  )}
                  {(selected.failure_reason || selected.cancel_reason) && (
                    <p className="mt-2 text-xs text-destructive">
                      {selected.failure_reason ?? selected.cancel_reason}
                    </p>
                  )}
                  {cancelError && (
                    <p className="mt-2 text-xs text-destructive">
                      {cancelError}
                    </p>
                  )}
                </div>
                <Transcript child={selected} />
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
};
