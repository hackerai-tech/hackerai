"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { GOAL_MAX_RUNS } from "@/lib/goals/contracts";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import { toast } from "sonner";

export function AgentGoalPanel({
  chatId,
  exists,
  eligible,
  idle,
  disabledReason,
  send,
  settings,
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
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [maxRuns, setMaxRuns] = useState(3);
  const [verificationCommand, setVerificationCommand] = useState("");
  const [constraints, setConstraints] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [stopWhen, setStopWhen] = useState("");
  const [reply, setReply] = useState("");
  const [additionalRuns, setAdditionalRuns] = useState(0);
  const [busy, setBusy] = useState(false);
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
    if (enabled && eligible && !exposure.current) {
      exposure.current = true;
      captureAuthenticatedEvent("agent_goal_exposed", {
        surface: "chat_goal_control",
      });
    }
  }, [enabled, eligible]);
  if ((!enabled || !eligible) && !goal) return null;
  const active = goal && !["achieved", "canceled"].includes(goal.state);
  const canResume =
    goal &&
    goal.state !== "achieved" &&
    !goal.activeRunId &&
    !["queued", "running", "needs_approval", "waiting"].includes(goal.state) &&
    (goal.runs < goal.maxRuns || additionalRuns > 0);
  async function control(action: "pause" | "stop") {
    setBusy(true);
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
      setBusy(false);
    }
  }
  async function submit(resume: boolean) {
    if (busy || !idle || disabledReason || !eligible || !enabled) return;
    setBusy(true);
    try {
      const successCriteria = criteria
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean);
      if (
        !resume &&
        (!objective.trim() ||
          !successCriteria.length ||
          successCriteria.length > 8 ||
          !Number.isInteger(maxRuns) ||
          maxRuns < 1 ||
          maxRuns > GOAL_MAX_RUNS)
      )
        throw new Error(
          "Enter an objective, 1–8 success criteria, and a run budget of 1–8.",
        );
      await send(
        {
          text: resume
            ? "Resume my saved goal from the latest progress within its original authorization and run budget.\n" +
              reply
            : "Goal: " +
              objective.trim() +
              "\nSuccess criteria:\n" +
              successCriteria.map((c, i) => i + 1 + ". " + c).join("\n"),
        },
        {
          body: {
            ...(resume && goal
              ? {
                  sandboxPreference: goal.sandboxPreference,
                  agentPermissionMode: goal.permissionMode,
                  selectedModel: goal.selectedModel,
                }
              : settings),
            mode: "agent",
            goal: resume
              ? { action: "resume", additionalRuns }
              : {
                  action: "start",
                  objective: objective.trim(),
                  criteria: successCriteria,
                  maxRuns,
                  verificationCommand,
                  constraints,
                  boundaries,
                  stopWhen,
                },
          },
        },
      );
      captureAuthenticatedEvent("agent_goal_user_control", {
        action: resume ? "resume" : "start",
        ...(resume ? {} : { max_runs: maxRuns }),
      });
      setOpen(false);
      setReply("");
      setAdditionalRuns(0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Goal could not start");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Agent goal"
      className="mx-auto w-full max-w-3xl max-h-[50vh] overflow-y-auto shrink-0 px-4 py-2 text-sm"
    >
      {goal && (
        <div
          className="rounded-lg border bg-muted/30 p-3 space-y-2"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>Goal · {goal.state.replaceAll("_", " ")}</strong>
            <span>
              {goal.runs}/{goal.maxRuns} runs used
            </span>
          </div>
          <p className="break-words whitespace-pre-wrap">{goal.objective}</p>
          <p className="text-muted-foreground break-words whitespace-pre-wrap">
            {goal.progress || goal.reason}
          </p>
          {goal.progress && (
            <p className="text-muted-foreground">{goal.reason}</p>
          )}
          <ul className="space-y-1">
            {goal.criteria.map((criterion, i) => (
              <li key={i} className="break-words">
                {goal.evidence.some((e) => e.criterion === i) ? "✓" : "○"}{" "}
                {criterion}
              </li>
            ))}
          </ul>
          {goal.state === "achieved" && (
            <p className="text-muted-foreground">
              Agent completion is backed by saved tool results. Review the
              evidence in the chat.
            </p>
          )}
          {goal.state !== "achieved" &&
            !goal.activeRunId &&
            !["queued", "running", "needs_approval", "waiting"].includes(
              goal.state,
            ) && (
              <div className="space-y-2">
                <label className="block">
                  Reply or new information
                  <Textarea
                    aria-label="Goal reply"
                    value={reply}
                    maxLength={4000}
                    onChange={(e) => setReply(e.target.value)}
                  />
                </label>
                {goal.runs >= goal.maxRuns && goal.maxRuns < GOAL_MAX_RUNS && (
                  <label className="block">
                    Additional runs (normal plan usage)
                    <Input
                      aria-label="Additional goal runs"
                      type="number"
                      min={0}
                      max={GOAL_MAX_RUNS - goal.maxRuns}
                      value={additionalRuns}
                      onChange={(e) =>
                        setAdditionalRuns(Number(e.target.value))
                      }
                      className="w-24"
                    />
                  </label>
                )}
              </div>
            )}
          <details>
            <summary className="cursor-pointer">
              Completion contract and evidence
            </summary>
            <div className="space-y-1 py-2">
              {goal.verificationCommand && (
                <p>
                  Verification: <code>{goal.verificationCommand}</code>
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
          <div className="flex flex-wrap gap-2">
            {active &&
              ["queued", "running", "needs_approval", "waiting"].includes(
                goal.state,
              ) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => control("pause")}
                >
                  Pause goal
                </Button>
              )}
            {canResume && (
              <Button
                size="sm"
                disabled={
                  busy || !idle || !enabled || !eligible || !!disabledReason
                }
                onClick={() => submit(true)}
              >
                Resume goal
              </Button>
            )}
            {active && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => control("stop")}
              >
                Stop goal
              </Button>
            )}
          </div>
        </div>
      )}
      {!active && enabled && eligible && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !idle || !!disabledReason}
          onClick={() => setOpen(!open)}
        >
          {open ? "Close goal setup" : "Set an Agent goal"}
        </Button>
      )}
      {open && !active && (
        <form
          className="space-y-3 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <label className="block">
            Objective
            <Textarea
              aria-label="Goal objective"
              value={objective}
              maxLength={4000}
              onChange={(e) => setObjective(e.target.value)}
              required
            />
          </label>
          <label className="block">
            Success criteria, one per line
            <Textarea
              aria-label="Goal success criteria"
              value={criteria}
              maxLength={8000}
              onChange={(e) => setCriteria(e.target.value)}
              required
            />
          </label>
          <label className="block">
            Maximum runs
            <Input
              aria-label="Goal maximum runs"
              type="number"
              min={1}
              max={GOAL_MAX_RUNS}
              value={maxRuns}
              onChange={(e) => setMaxRuns(Number(e.target.value))}
              className="w-24"
            />
          </label>
          <details>
            <summary className="cursor-pointer">
              Verification and boundaries (optional)
            </summary>
            <div className="space-y-2 py-2">
              <label className="block">
                Verification command
                <Input
                  aria-label="Goal verification command"
                  value={verificationCommand}
                  maxLength={2000}
                  onChange={(e) => setVerificationCommand(e.target.value)}
                  placeholder="A test command that must exit successfully"
                />
              </label>
              <label className="block">
                What to preserve
                <Textarea
                  aria-label="Goal constraints"
                  value={constraints}
                  maxLength={2000}
                  onChange={(e) => setConstraints(e.target.value)}
                />
              </label>
              <label className="block">
                Authorized scope
                <Textarea
                  aria-label="Goal boundaries"
                  value={boundaries}
                  maxLength={2000}
                  onChange={(e) => setBoundaries(e.target.value)}
                />
              </label>
              <label className="block">
                Stop and ask for input when
                <Textarea
                  aria-label="Goal stop conditions"
                  value={stopWhen}
                  maxLength={2000}
                  onChange={(e) => setStopWhen(e.target.value)}
                />
              </label>
            </div>
          </details>
          <p className="text-muted-foreground">
            Works while you’re away in work slices of up to 20 minutes. Every
            continuation consumes normal plan usage. Existing spend and usage
            limits still stop the goal. Approval and input waits require your
            response. The run budget grows only when you explicitly add runs;
            reaching it leaves the goal unfinished.
          </p>
          <p className="text-muted-foreground">
            Sandbox, model and permission mode are fixed when the goal starts. A
            connected computer must stay online.
          </p>
          <Button
            type="submit"
            size="sm"
            disabled={busy || !idle || !!disabledReason}
          >
            Start goal
          </Button>
        </form>
      )}
    </section>
  );
}
