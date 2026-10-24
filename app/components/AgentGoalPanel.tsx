"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { ChevronDown, Target, Pause, Trash2, Pencil } from "lucide-react";
import { goalResumeMessage } from "@/lib/goals/commands";
import { GOAL_MAX_RUNS, type GoalState } from "@/lib/goals/contracts";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import { toast } from "sonner";

import { useGlobalState } from "@/app/contexts/GlobalState";

const stateLabels: Record<GoalState, string> = {
  queued: "Queued",
  running: "Working",
  waiting: "Waiting",
  paused: "Paused",
  needs_input: "Needs your input",
  needs_approval: "Needs approval",
  blocked: "Blocked",
  failed: "Run failed",
  canceled: "Stopped",
  usage_exhausted: "Usage limit reached",
  budget_exhausted: "Run budget reached",
  achieved: "Completed",
};

export function AgentGoalPanel({
  chatId,
  exists,
  eligible,
  idle,
  disabledReason,
  send,
}: {
  chatId: string;
  exists: boolean;
  eligible: boolean;
  idle: boolean;
  disabledReason?: string;
  send: (
    message: { text: string },
    options: { body: Record<string, unknown> },
  ) => Promise<void>;
  settings: {
    sandboxPreference: string;
    agentPermissionMode: string;
    selectedModel: string;
  };
}) {
  const goal = useQuery(api.agentGoals.get, exists ? { chatId } : "skip");
  const [enabled, setEnabled] = useState(false);
  const { openSidebar } = useGlobalState();
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const openingEditor = useRef(false);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();
  const [formError, setFormError] = useState("");
  const [reply, setReply] = useState("");
  const [additionalRuns, setAdditionalRuns] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [controlling, setControlling] = useState(false);
  const busy = submitting || controlling;
  const exposure = useRef(false);
  useEffect(() => {
    if (!eligible) return;
    const abort = new AbortController();
    fetch(
      exists
        ? `/api/agent-goal?chatId=${encodeURIComponent(chatId)}`
        : "/api/agent-goal",
      { signal: abort.signal, cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => setEnabled(r?.enabled === true))
      .catch(() => undefined);
    return () => abort.abort();
  }, [eligible, exists, chatId]);
  useEffect(() => {
    if (goal && enabled && eligible && !exposure.current) {
      exposure.current = true;
      captureAuthenticatedEvent("agent_goal_exposed", {
        surface: "chat_goal_control",
      });
    }
  }, [enabled, eligible, goal]);
  useEffect(() => {
    setMobileOpen(false);
    setExpanded(false);
  }, [chatId, goal?._id]);
  if (!goal) return null;
  const active = goal && !["achieved", "canceled"].includes(goal.state);
  const resumable =
    goal &&
    goal.state !== "achieved" &&
    !goal.activeRunId &&
    !["queued", "running", "needs_approval", "waiting"].includes(goal.state);
  const validAdditionalRuns =
    Number.isInteger(additionalRuns) &&
    additionalRuns >= 0 &&
    additionalRuns <= GOAL_MAX_RUNS - (goal?.maxRuns ?? 0);
  const canResume =
    goal &&
    goal.state !== "achieved" &&
    !goal.activeRunId &&
    !["queued", "running", "needs_approval", "waiting"].includes(goal.state) &&
    validAdditionalRuns &&
    (goal.runs < goal.maxRuns || additionalRuns > 0);
  async function control(action: "pause" | "clear") {
    setControlling(true);
    try {
      const r = await fetch("/api/agent-goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, action }),
      });
      if (!r.ok)
        throw new Error((await r.json()).message ?? "Goal control failed");
      captureAuthenticatedEvent("agent_goal_user_control", { action });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Goal control failed");
    } finally {
      setControlling(false);
    }
  }
  async function submit() {
    if (
      busy ||
      !idle ||
      disabledReason ||
      !eligible ||
      !enabled ||
      !goal ||
      !canResume
    )
      return;
    setSubmitting(true);
    setFormError("");
    setMobileOpen(false);
    try {
      await send(
        {
          text: goalResumeMessage(goal, reply),
        },
        {
          body: {
            sandboxPreference: goal.sandboxPreference,
            agentPermissionMode: goal.permissionMode,
            selectedModel: goal.selectedModel,
            mode: "agent",
            goal: { action: "resume", additionalRuns },
          },
        },
      );
      captureAuthenticatedEvent("agent_goal_user_control", {
        action: "resume",
      });
      setReply("");
      setAdditionalRuns(0);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Goal could not resume";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }
  const actions = (
    <div
      className={`flex shrink-0 items-center justify-end gap-0.5 text-muted-foreground empty:hidden ${isMobile ? "[&_button]:min-h-11 [&_button]:min-w-11" : ""}`}
    >
      {active &&
        ["queued", "running", "needs_approval", "waiting"].includes(
          goal.state,
        ) && (
          <Button
            size={isMobile ? "icon" : "icon-sm"}
            variant="ghost"
            disabled={controlling}
            aria-label="Pause goal"
            title="Pause goal"
            onClick={() => control("pause")}
          >
            <Pause className="size-4" />
          </Button>
        )}
      {(canResume || (goal.state === "paused" && goal.runs < goal.maxRuns)) && (
        <Button
          size="sm"
          variant="ghost"
          className="px-2 text-xs"
          aria-label="Resume goal"
          disabled={
            busy ||
            !canResume ||
            !idle ||
            !enabled ||
            !eligible ||
            !!disabledReason
          }
          onClick={() => submit()}
        >
          Resume
        </Button>
      )}
      {resumable &&
        goal.runs >= goal.maxRuns &&
        goal.maxRuns < GOAL_MAX_RUNS &&
        !expanded && (
          <Button
            size="sm"
            variant="ghost"
            className="px-2 text-xs"
            onClick={() => setExpanded(true)}
          >
            Add runs
          </Button>
        )}
      {goal.state !== "achieved" && (
        <Button
          size={isMobile ? "icon" : "icon-sm"}
          variant="ghost"
          aria-label="Edit goal"
          title="Edit goal"
          disabled={controlling}
          onClick={() => {
            openingEditor.current = isMobile === true;
            setMobileOpen(false);
            if (isMobile) mobileTriggerRef.current?.focus();
            openSidebar({ kind: "goal", chatId });
          }}
        >
          <Pencil className="size-4" />
        </Button>
      )}
      {goal && (
        <Button
          size={isMobile ? "icon" : "icon-sm"}
          variant="ghost"
          disabled={controlling}
          aria-label="Delete goal"
          title="Delete goal"
          onClick={() => control("clear")}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  );
  const details = (
    <div
      id={detailsId}
      className={
        isMobile
          ? "space-y-3 border-t pt-3 text-sm"
          : "mb-2 max-h-[35dvh] space-y-3 overflow-y-auto overscroll-contain rounded-xl border bg-background p-3 break-words [overflow-wrap:anywhere]"
      }
    >
      <p className="text-xs text-muted-foreground">
        {goal.runs}/{goal.maxRuns} runs used
      </p>
      {resumable && (
        <div className="space-y-2">
          {goal.runs >= goal.maxRuns && goal.maxRuns < GOAL_MAX_RUNS && (
            <label className="block">
              Additional runs (normal plan usage)
              <Input
                aria-label="Additional goal runs"
                type="number"
                min={0}
                max={GOAL_MAX_RUNS - goal.maxRuns}
                step={1}
                value={additionalRuns}
                onChange={(e) => setAdditionalRuns(Number(e.target.value))}
                className="w-24"
              />
              <span className="text-xs text-muted-foreground">
                Add 1–{GOAL_MAX_RUNS - goal.maxRuns} runs, then choose Resume
                goal.
              </span>
              {!validAdditionalRuns && (
                <span role="alert" className="block text-destructive">
                  Choose a whole number from 1 to {GOAL_MAX_RUNS - goal.maxRuns}
                  .
                </span>
              )}
            </label>
          )}
          <label className="block">
            Reply or new information (optional)
            <Textarea
              aria-label="Goal reply"
              value={reply}
              maxLength={4000}
              onChange={(e) => setReply(e.target.value)}
            />
          </label>
          {goal.runs >= GOAL_MAX_RUNS && (
            <p className="text-muted-foreground">
              This goal used all {GOAL_MAX_RUNS} runs.{" "}
              {active
                ? "Stop it, then set a new goal to continue with a fresh budget."
                : "Set a new goal to continue with a fresh budget."}
            </p>
          )}
          {disabledReason && (
            <p className="text-muted-foreground">{disabledReason}</p>
          )}
          {(!enabled || !eligible) && (
            <p className="text-muted-foreground">
              Starting or resuming goals requires Agent mode, a paid plan, and
              goal access.
            </p>
          )}
          {formError && (
            <p role="alert" className="text-destructive">
              {formError}
            </p>
          )}
        </div>
      )}
      <p className="whitespace-pre-wrap">{goal.objective}</p>
      <p>{goal.reason}</p>
      {goal.state !== "achieved" &&
        goal.progress &&
        goal.progress !== goal.reason && (
          <p className="text-muted-foreground whitespace-pre-wrap">
            Latest progress: {goal.progress}
          </p>
        )}
      {goal.judgment && goal.judgment.reason !== goal.reason && (
        <p className="text-muted-foreground">
          Completion check: {goal.judgment.reason}
        </p>
      )}
      <ul className="space-y-1">
        {goal.criteria.map((criterion, i) => (
          <li key={i}>
            {goal.state === "achieved" ? "✓ " : `${i + 1}. `}
            {criterion}
            {goal.state !== "achieved" &&
              goal.evidence.some((e) => e.criterion === i) && (
                <span className="text-xs text-muted-foreground">
                  {" "}
                  · Evidence saved, awaiting verification
                </span>
              )}
          </li>
        ))}
      </ul>
      <details>
        <summary className="cursor-pointer">
          Completion contract and evidence
        </summary>
        <div className="space-y-1 py-2">
          {goal.verificationCommand && (
            <p>
              Verification:{" "}
              <code className="whitespace-pre-wrap">
                {goal.verificationCommand}
              </code>
            </p>
          )}
          {goal.constraints && <p>Preserve: {goal.constraints}</p>}
          {goal.boundaries && <p>Scope: {goal.boundaries}</p>}
          {goal.stopWhen && <p>Ask for input when: {goal.stopWhen}</p>}
          {goal.evidence.map((e) => (
            <p key={e.criterion}>
              Criterion {e.criterion + 1}: {e.explanation} ·{" "}
              <a
                className="underline"
                href={getSourceMessageHref(chatId, e.messageId ?? e.runId)}
              >
                saved run evidence
              </a>
            </p>
          ))}
        </div>
      </details>
    </div>
  );
  if (isMobile) {
    const mobileLabel =
      goal.state === "running"
        ? "Pursuing goal"
        : goal.state === "achieved"
          ? "Goal achieved"
          : ["paused", "queued", "canceled", "blocked"].includes(goal.state)
            ? `${stateLabels[goal.state]} goal`
            : stateLabels[goal.state];
    return (
      <section
        aria-label="Agent goal"
        className="relative z-10 order-1 flex min-w-0 shrink-0 justify-center py-2"
      >
        <Popover open={mobileOpen} onOpenChange={setMobileOpen}>
          <PopoverTrigger asChild>
            <button
              ref={mobileTriggerRef}
              type="button"
              aria-label={
                mobileOpen ? "Hide goal controls" : "Show goal controls"
              }
              className="flex min-h-11 max-w-full items-center gap-2 rounded-full border bg-background/95 px-4 py-2 text-sm text-muted-foreground shadow-sm backdrop-blur-md transition-colors data-[state=open]:bg-foreground data-[state=open]:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Target className="size-4 shrink-0" aria-hidden="true" />
              <span
                role="status"
                aria-live="polite"
                className="min-w-0 truncate"
              >
                {mobileLabel}
              </span>
              {goal.startedAt !== undefined && (
                <GoalElapsedTime
                  startedAt={goal.startedAt}
                  achievedAt={goal.achievedAt}
                />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            sideOffset={12}
            collisionPadding={12}
            aria-label="Goal controls"
            onCloseAutoFocus={(event) => {
              if (openingEditor.current) event.preventDefault();
              openingEditor.current = false;
            }}
            className="w-[calc(100vw-2rem)] max-w-sm max-h-[min(60dvh,var(--radix-popover-content-available-height))] space-y-2 overflow-y-auto overscroll-contain rounded-2xl bg-popover/95 p-3 shadow-xl backdrop-blur-xl break-words [overflow-wrap:anywhere]"
          >
            <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-sm">
              {goal.objective}
            </p>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => setExpanded(!expanded)}
                className="flex min-h-11 items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Details{" "}
                <ChevronDown
                  className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </button>
              {actions}
            </div>
            {expanded && details}
          </PopoverContent>
        </Popover>
      </section>
    );
  }
  return (
    <section
      aria-label="Agent goal"
      className="relative z-10 order-1 mx-1 min-w-0 shrink-0 bg-background text-sm"
    >
      {goal && (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1 py-1">
            <button
              type="button"
              aria-label={expanded ? "Hide goal details" : "Show goal details"}
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded(!expanded)}
              title={`${goal.objective} · ${goal.runs}/${goal.maxRuns} runs`}
              className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Target className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                <span
                  role="status"
                  aria-live="polite"
                  className="font-medium text-foreground/80"
                >
                  Goal · {stateLabels[goal.state]}
                </span>
                <span className="mx-1.5" aria-hidden="true">
                  ·
                </span>
                <span>{goal.objective}</span>
              </span>
              <ChevronDown
                className={`size-3 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            {actions}
          </div>
          {expanded && details}
        </div>
      )}
    </section>
  );
}

function GoalElapsedTime({
  startedAt,
  achievedAt,
}: {
  startedAt: number;
  achievedAt?: number;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (achievedAt !== undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [achievedAt]);
  const seconds = Math.max(
    0,
    Math.floor(((achievedAt ?? now) - startedAt) / 1000),
  );
  const duration =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return (
    <span
      aria-label={`Elapsed time ${duration}, including pauses and waiting`}
      className="shrink-0 tabular-nums"
      title="Elapsed time since goal creation, including pauses and waiting"
    >
      {duration}
    </span>
  );
}
