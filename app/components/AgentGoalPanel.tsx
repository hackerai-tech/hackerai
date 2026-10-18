"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
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
  return (
    <section
      aria-label="Agent goal"
      className="relative z-10 order-1 mx-2 min-w-0 shrink-0 text-sm"
    >
      {goal && (
        <div className="min-w-0 rounded-t-2xl border border-b-0 bg-muted/50 pb-2 -mb-2">
          <div className="flex flex-wrap items-center gap-2 p-2">
            <button
              type="button"
              aria-label={expanded ? "Hide goal details" : "Show goal details"}
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded(!expanded)}
              className="flex min-w-0 flex-1 basis-full sm:basis-0 items-center gap-2 rounded-md p-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Target
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <strong role="status" aria-live="polite">
                    Goal · {stateLabels[goal.state]}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    {goal.runs}/{goal.maxRuns} runs
                  </span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {goal.objective}
                </span>
              </span>
              <ChevronDown
                className={`size-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
            <div className="flex w-full flex-wrap justify-end gap-1 empty:hidden sm:w-auto">
              {active &&
                ["queued", "running", "needs_approval", "waiting"].includes(
                  goal.state,
                ) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={controlling}
                    aria-label="Pause goal"
                    title="Pause goal"
                    onClick={() => control("pause")}
                  >
                    <Pause className="size-4" />
                  </Button>
                )}
              {canResume && (
                <Button
                  size="sm"
                  disabled={
                    busy || !idle || !enabled || !eligible || !!disabledReason
                  }
                  onClick={() => submit()}
                >
                  Resume goal
                </Button>
              )}
              {resumable &&
                goal.runs >= goal.maxRuns &&
                goal.maxRuns < GOAL_MAX_RUNS &&
                !expanded && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setExpanded(true)}
                  >
                    Add runs
                  </Button>
                )}
              {goal.state !== "achieved" && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Edit goal"
                  title="Edit goal"
                  disabled={controlling}
                  onClick={() => openSidebar({ kind: "goal", chatId })}
                >
                  <Pencil className="size-4" />
                </Button>
              )}
              {goal && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={controlling}
                  aria-label="Delete goal"
                  title="Delete goal"
                  onClick={() => control("clear")}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </div>
          {expanded && (
            <div
              id={detailsId}
              className="max-h-[35dvh] space-y-3 overflow-y-auto overscroll-contain border-t p-3 break-words [overflow-wrap:anywhere]"
            >
              {resumable && (
                <div className="space-y-2">
                  {goal.runs >= goal.maxRuns &&
                    goal.maxRuns < GOAL_MAX_RUNS && (
                      <label className="block">
                        Additional runs (normal plan usage)
                        <Input
                          aria-label="Additional goal runs"
                          type="number"
                          min={0}
                          max={GOAL_MAX_RUNS - goal.maxRuns}
                          step={1}
                          value={additionalRuns}
                          onChange={(e) =>
                            setAdditionalRuns(Number(e.target.value))
                          }
                          className="w-24"
                        />
                        <span className="text-xs text-muted-foreground">
                          Add 1–{GOAL_MAX_RUNS - goal.maxRuns} runs, then choose
                          Resume goal.
                        </span>
                        {!validAdditionalRuns && (
                          <span role="alert" className="block text-destructive">
                            Choose a whole number from 1 to{" "}
                            {GOAL_MAX_RUNS - goal.maxRuns}.
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
                      Starting or resuming goals requires Agent mode, a paid
                      plan, and goal access.
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
                        href={getSourceMessageHref(
                          chatId,
                          e.messageId ?? e.runId,
                        )}
                      >
                        saved run evidence
                      </a>
                    </p>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
