"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { GoalTargetIcon } from "@/components/icons/goal-target";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { X } from "lucide-react";
import { goalEditText, parseGoalCommand } from "@/lib/goals/commands";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { toast } from "sonner";

type Goal = Doc<"agent_goals">;

export function AgentGoalEditor({
  chatId,
  onClose,
  stopRunBeforeControl,
}: {
  chatId: string;
  onClose: () => void;
  stopRunBeforeControl?: (runId: string) => Promise<boolean>;
}) {
  const goal = useQuery(api.agentGoals.get, { chatId });
  const [original, setOriginal] = useState<Goal | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (goal && !original) {
      setOriginal(goal);
      setText(goalEditText(goal));
    }
  }, [goal, original]);
  useEffect(() => {
    if (original) input.current?.focus();
  }, [original]);

  // Worker continuations advance the generation without changing the user's
  // objective. Retain the draft across those updates, but reject other edits.
  const matchesOriginal = (current: Goal | null | undefined) =>
    !!current &&
    !current.deletedAt &&
    !!original &&
    current._id === original._id &&
    current.startedAt === original.startedAt &&
    goalEditText(current) === goalEditText(original);
  const stale = !!original && goal !== undefined && !matchesOriginal(goal);
  let parsed: ReturnType<typeof parseGoalCommand> = null;
  let validation = "";
  if (text.trim()) {
    try {
      parsed = parseGoalCommand(`/goal start ${text}`);
    } catch (e) {
      validation = e instanceof Error ? e.message : "Check your goal text.";
    }
  }
  const canSave =
    !!original &&
    !!goal &&
    !stale &&
    !saving &&
    parsed?.action === "start" &&
    text.trim() !== goalEditText(original).trim();

  async function readCurrentGoal() {
    const response = await fetch(
      `/api/agent-goal?chatId=${encodeURIComponent(chatId)}`,
      { cache: "no-store" },
    );
    if (!response.ok)
      throw new Error("Could not check the current goal. Try again.");
    const current = (await response.json()).goal as Goal | null;
    if (!matchesOriginal(current))
      throw new Error(
        "The goal changed or was cleared. Reopen Edit before saving.",
      );
    return current!;
  }
  async function save() {
    if (!canSave || parsed?.action !== "start") return;
    setSaving(true);
    setError("");
    try {
      let current = await readCurrentGoal();
      if (!mounted.current) return;
      if (current.activeRunId) {
        if (
          !stopRunBeforeControl ||
          !(await stopRunBeforeControl(current.activeRunId))
        )
          throw new Error(
            "Could not stop and save the current run. Your edit is kept; try again.",
          );
        // Stopping or finishing can advance the generation. Read it after the
        // response is saved, then let the mutation fence any subsequent race.
        current = await readCurrentGoal();
      }
      if (!mounted.current) return;
      const {
        action: _action,
        expectedGeneration: _version,
        ...fields
      } = parsed;
      const response = await fetch("/api/agent-goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...fields,
          action: "update",
          chatId,
          generation: current.generation,
        }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).message ?? "Could not save the goal.",
        );
      captureAuthenticatedEvent("agent_goal_user_control", {
        action: "update",
      });
      if (mounted.current) {
        toast.success("Goal updated. Resume when ready.");
        onClose();
      }
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "Could not save the goal.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-background"
      aria-label="Goal editor"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <GoalTargetIcon className="size-4 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-medium">Edit goal</h2>
        <Button
          size="sm"
          className="min-h-11 md:min-h-0"
          disabled={!canSave}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0"
          aria-label="Close goal editor"
          disabled={saving}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <Textarea
        ref={input}
        aria-label="Goal objective"
        placeholder="Describe your goal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!original || saving}
        className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-4 text-base shadow-none focus-visible:ring-0 md:text-sm"
      />
      <div className="shrink-0 space-y-2 border-t px-4 py-3 text-xs text-muted-foreground">
        <p role="status">
          {stale
            ? "The goal changed or was cleared. Your draft is kept; reopen Edit before saving."
            : !original
              ? goal === undefined
                ? "Loading goal…"
                : "This goal is no longer available."
              : goal &&
                  ["running", "queued", "waiting", "needs_approval"].includes(
                    goal.state,
                  )
                ? "The agent keeps working while you edit. Save pauses the goal so you can resume with your changes."
                : "Save changes, then Resume to pursue the updated goal."}
        </p>
        {(error || validation) && (
          <p role="alert" className="text-destructive">
            {error || validation}
          </p>
        )}
      </div>
    </section>
  );
}
