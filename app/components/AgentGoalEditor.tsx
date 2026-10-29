"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { GoalTargetIcon } from "@/components/icons/goal-target";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { X } from "lucide-react";
import { goalEditText } from "@/lib/goals/commands";
import { defaultGoalCriterion, validGoalStart } from "@/lib/goals/contracts";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { toast } from "sonner";

type Goal = Doc<"agent_goals">;
export type GoalEditorDraft = { chatId: string; original: Goal; text: string };

export function AgentGoalEditor({
  chatId,
  onClose,
  stopRunBeforeControl,
  draft,
  onDraftChange,
  continueGoal,
}: {
  chatId: string;
  onClose: () => void;
  stopRunBeforeControl?: (runId: string) => Promise<boolean>;
  draft?: GoalEditorDraft;
  onDraftChange?: (draft: GoalEditorDraft) => void;
  continueGoal?: (goal: Goal) => Promise<void>;
}) {
  const goal = useQuery(api.agentGoals.get, { chatId });
  const [original, setOriginal] = useState<Goal | null>(
    draft?.original ?? null,
  );
  const [text, setText] = useState(draft?.text ?? "");
  const [saving, setSaving] = useState(false);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const statusId = useId();
  const errorId = useId();
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
      setText(goal.objective);
    }
  }, [goal, original]);
  useEffect(() => {
    if (original) input.current?.focus();
  }, [original]);

  useEffect(() => {
    if (original) onDraftChange?.({ chatId, original, text });
  }, [chatId, original, text, onDraftChange]);

  // Worker continuations advance the generation without changing the user's
  // objective. Retain the draft across those updates, but reject other edits.
  const matchesOriginal = (current: Goal | null | undefined) =>
    !!current &&
    !current.deletedAt &&
    !!original &&
    current._id === original._id &&
    current.startedAt === original.startedAt &&
    goalEditText(current) === goalEditText(original);
  const stale =
    !saving && !!original && goal !== undefined && !matchesOriginal(goal);
  // This is a plain-text editor, not a slash-command parser. Retain legacy
  // explicit constraints; only the implicit criterion follows a revised request.
  const objective = text.trim();
  const fields = original
    ? {
        objective,
        criteria:
          original.criteria.length === 1 &&
          original.criteria[0] === defaultGoalCriterion(original.objective)
            ? [defaultGoalCriterion(objective)]
            : original.criteria,
        verificationCommand: original.verificationCommand,
        constraints: original.constraints,
        boundaries: original.boundaries,
        stopWhen: original.stopWhen,
      }
    : null;
  const valid = !!fields && validGoalStart(fields);
  const validation =
    objective && !valid ? "Use a goal between 1 and 4,000 characters." : "";
  const willContinue =
    !!continueGoal && ["running", "queued"].includes(goal?.state ?? "");
  const canSave =
    !!original &&
    !!goal &&
    !stale &&
    !saving &&
    valid &&
    objective !== original.objective.trim();

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
        "The goal changed or was cleared. Copy your draft if needed, then close and reopen Edit.",
      );
    return current!;
  }
  async function waitForSavedGoal(generation: number): Promise<Goal | null> {
    const deadline = Date.now() + 10_000;
    while (mounted.current) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          "The previous run is still stopping. Resume when ready.",
        );
      const response = await fetch(
        `/api/agent-goal?chatId=${encodeURIComponent(chatId)}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(remaining),
        },
      );
      if (!response.ok)
        throw new Error(
          "Could not check whether the previous run stopped. Resume when ready.",
        );
      const current = (await response.json()).goal as Goal | null;
      if (
        !current ||
        current.deletedAt ||
        current._id !== original?._id ||
        current.generation !== generation ||
        current.state !== "paused"
      ) {
        throw new Error(
          "The goal changed before it could continue. Check its current state.",
        );
      }
      if (!current.activeRunId) return current;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }
  async function save() {
    if (!canSave || !fields) return;
    setSaving(true);
    setError("");
    try {
      let current = await readCurrentGoal();
      if (!mounted.current) return;
      const shouldContinue =
        !!continueGoal && ["running", "queued"].includes(current.state);
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
      const saved = await response.json();
      captureAuthenticatedEvent("agent_goal_user_control", {
        action: "update",
        continue_after_update: shouldContinue,
      });
      if (mounted.current) {
        if (shouldContinue && Number.isSafeInteger(saved.generation)) {
          setSettling(true);
          try {
            const settled = await waitForSavedGoal(saved.generation);
            if (!settled || !mounted.current) return;
            current = settled;
          } catch (cause) {
            if (mounted.current) {
              onClose();
              toast.error(
                `Goal saved. Could not continue: ${cause instanceof Error ? cause.message : "Resume when ready."}`,
              );
            }
            return;
          }
        }
        onClose();
        if (shouldContinue) {
          // send resolves when streaming ends. Close the editor immediately so
          // another edit is possible while the replacement run is working.
          if (!Number.isSafeInteger(saved.generation)) {
            toast.error(
              "Goal saved. Could not continue; reload and Resume when ready.",
            );
          } else {
            toast.success("Goal updated. Continuing…");
            void continueGoal({
              ...current,
              ...fields,
              generation: saved.generation,
            }).catch((cause) => {
              toast.error(
                `Goal saved. Could not continue: ${cause instanceof Error ? cause.message : "Check the chat and Resume when ready."}`,
              );
            });
          }
        } else {
          toast.success("Goal updated. Resume when ready.");
        }
      }
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "Could not save the goal.");
    } finally {
      if (mounted.current) {
        setSaving(false);
        setSettling(false);
        input.current?.focus();
      }
    }
  }

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[22px] border bg-background desktop:mr-4"
      aria-label="Goal editor"
      aria-busy={saving}
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <GoalTargetIcon
          className="size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="flex-1 text-sm font-medium">Edit goal</h2>
        <Button
          size="sm"
          className="min-h-11 desktop:min-h-0"
          aria-describedby={statusId}
          aria-label={
            willContinue && !saving ? "Update and continue" : undefined
          }
          disabled={!canSave}
          onClick={save}
        >
          {saving ? (
            settling ? (
              "Continuing…"
            ) : (
              "Saving…"
            )
          ) : willContinue ? (
            <>
              <span className="desktop:hidden">Update</span>
              <span className="hidden desktop:inline">Update and continue</span>
            </>
          ) : (
            "Save"
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 desktop:min-h-0 desktop:min-w-0"
          aria-label="Close goal editor"
          disabled={saving}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      {(error || validation || stale) && (
        <p
          id={errorId}
          role="alert"
          className="shrink-0 px-4 py-3 text-sm text-destructive"
        >
          {stale
            ? "The goal changed or was cleared. Copy your draft if needed, then close and reopen Edit."
            : error || validation}
        </p>
      )}
      <Textarea
        ref={input}
        aria-label="Goal objective"
        placeholder="Describe your goal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!original}
        readOnly={saving}
        aria-invalid={!!validation}
        aria-describedby={error || validation || stale ? errorId : undefined}
        className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-4 text-base shadow-none focus-visible:ring-0 md:text-sm"
      />
      <div className="shrink-0 space-y-2 border-t px-4 py-3 text-xs text-muted-foreground">
        <p id={statusId} role="status">
          {settling
            ? "Waiting for the previous run to stop before continuing with your saved goal…"
            : stale
              ? "The goal changed or was cleared. Your unsaved draft remains above."
              : !original
                ? goal === undefined
                  ? "Loading goal…"
                  : "This goal is no longer available."
                : goal &&
                    ["running", "queued", "waiting", "needs_approval"].includes(
                      goal.state,
                    )
                  ? willContinue
                    ? "The agent keeps working while you edit. Updating stops this run, keeps its partial response, and continues with the revised goal."
                    : "Saving keeps the revised goal paused until you resume."
                  : goal?.state === "achieved"
                    ? "Saving reopens this goal and resets its completion check. Resume when ready."
                    : "Save changes, then Resume to pursue the updated goal."}
        </p>
      </div>
    </section>
  );
}
