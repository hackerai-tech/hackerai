"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Target, X } from "lucide-react";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { toast } from "sonner";

export function AgentGoalEditor({
  chatId,
  onClose,
}: {
  chatId: string;
  onClose: () => void;
}) {
  const goal = useQuery(api.agentGoals.get, { chatId });
  return (
    <section
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-background"
      aria-label="Edit goal"
    >
      <header className="flex items-center gap-2 border-b p-3">
        <Target className="size-4" />
        <h2 className="flex-1 font-medium">Edit goal</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close goal editor"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      {goal === undefined ? (
        <p className="p-4">Loading goal…</p>
      ) : !goal || goal.state === "achieved" ? (
        <p className="p-4">This goal is no longer editable.</p>
      ) : (
        <GoalForm key={goal._id} goal={goal} onClose={onClose} />
      )}
    </section>
  );
}

function GoalForm({
  goal,
  onClose,
}: {
  goal: Doc<"agent_goals">;
  onClose: () => void;
}) {
  // Keep the original version with the draft. Reactive run updates must not
  // overwrite edits or silently save them against a different objective.
  const [version] = useState(goal.generation);
  const [objective, setObjective] = useState(goal.objective);
  const [criteria, setCriteria] = useState(goal.criteria.join("\n"));
  const [contract, setContract] = useState({
    verificationCommand: goal.verificationCommand ?? "",
    constraints: goal.constraints ?? "",
    boundaries: goal.boundaries ?? "",
    stopWhen: goal.stopWhen ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const stale = version !== goal.generation;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || stale) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/agent-goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          chatId: goal.chatId,
          generation: version,
          objective,
          criteria: criteria
            .split("\n")
            .map((c) => c.trim())
            .filter(Boolean),
          ...contract,
        }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).message ?? "Could not update goal",
        );
      captureAuthenticatedEvent("agent_goal_user_control", {
        action: "update",
      });
      toast.success("Goal updated and paused. Resume when ready.");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update goal");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {goal.runs}/{goal.maxRuns} runs used
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={saving || stale || !objective.trim() || !criteria.trim()}
        >
          {saving ? "Saving…" : "Save and pause"}
        </Button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">
          Saving pauses current work. Resume from the goal bar with the
          remaining run budget.
        </p>
        {stale && (
          <p role="alert" className="text-sm text-destructive">
            The goal changed while this editor was open. Copy your draft, then
            close and reopen the editor before saving.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <label className="block space-y-2 text-sm">
          <span>Goal</span>
          <Textarea
            autoFocus
            aria-label="Goal objective"
            value={objective}
            onChange={(e) => {
              if (criteria.trim() === objective.trim())
                setCriteria(e.target.value);
              setObjective(e.target.value);
            }}
            maxLength={4000}
            rows={6}
            required
          />
        </label>
        <label className="block space-y-2 text-sm">
          <span>Success criteria · one per line</span>
          <Textarea
            aria-label="Goal success criteria"
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={4}
            required
          />
        </label>
        <details>
          <summary className="cursor-pointer text-sm">
            Scope and verification
          </summary>
          <div className="space-y-3 pt-3">
            {(
              [
                ["verificationCommand", "Verification command", 2000],
                ["constraints", "Preserve", 2000],
                ["boundaries", "Scope", 2000],
                ["stopWhen", "Ask for input when", 2000],
              ] as const
            ).map(([key, label, limit]) => (
              <label key={key} className="block space-y-1 text-sm">
                <span>{label}</span>
                <Textarea
                  aria-label={label}
                  value={contract[key]}
                  maxLength={limit}
                  onChange={(e) =>
                    setContract({ ...contract, [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
        </details>
      </div>
    </form>
  );
}
