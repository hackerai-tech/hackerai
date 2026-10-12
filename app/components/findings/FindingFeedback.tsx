"use client";
import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { captureFindingEvent } from "@/lib/findings/client-telemetry";
import type { FindingDetailRecord } from "@/types/finding";

const answers = {
  useful: "Useful and reproducible",
  needs_correction: "Needs correction",
  not_checked: "Haven’t checked",
} as const;

/** Voluntary inline feedback; no popup, recurring prompt, or report content capture. */
export function FindingFeedback({ finding }: { finding: FindingDetailRecord }) {
  const submit = useMutation(api.findings.submitFindingFeedback);
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<keyof typeof answers | undefined>(
    finding.usefulness_feedback?.report_updated_at === finding.updated_at
      ? finding.usefulness_feedback.answer
      : undefined,
  );
  const save = async (value: keyof typeof answers) => {
    setPending(true);
    try {
      const result = await submit({
        findingId: finding.finding_id,
        expectedUpdatedAt: finding.updated_at,
        answer: value,
      });
      if (!result.success) {
        captureFindingEvent({
          operation: "feedback",
          outcome: "rejected",
          reason: result.error,
        });
        toast.error(
          result.error === "conflict"
            ? "This report changed. Review the latest version before rating it."
            : "This finding is no longer available.",
        );
        return;
      }
      setAnswer(value);
      if (result.changed)
        captureFindingEvent({
          operation: "feedback",
          outcome: "success",
          answer: value,
          finding_id: finding.finding_id,
          report_updated_at: finding.updated_at,
        });
      toast.success("Feedback saved");
    } catch {
      captureFindingEvent({
        operation: "feedback",
        outcome: "uncertain",
        reason: "general",
      });
      toast.error(
        "Could not confirm feedback. Reload to check before trying again.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      className="space-y-3 rounded-lg border border-border p-4"
      aria-label="Finding feedback"
    >
      <h4 className="text-sm font-semibold">
        Was this finding useful and reproducible?
      </h4>
      <p className="text-xs text-muted-foreground">
        Your feedback applies to this version. It does not change the report or
        its status.
      </p>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(answers) as Array<keyof typeof answers>).map((value) => (
          <Button
            key={value}
            variant={answer === value ? "default" : "outline"}
            size="sm"
            disabled={pending}
            aria-pressed={answer === value}
            onClick={() => void save(value)}
          >
            {answers[value]}
          </Button>
        ))}
      </div>
    </section>
  );
}
