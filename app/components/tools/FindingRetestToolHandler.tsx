"use client";

import Link from "next/link";
import { memo } from "react";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import type { ChatStatus, SidebarToolError } from "@/types/chat";
import ToolBlock from "@/components/ui/tool-block";
import { ToolErrorHandler } from "./ToolErrorHandler";

export type FindingRetestToolName =
  "get_finding_retests" | "start_finding_retest" | "complete_finding_retest";

const WORKING: Record<FindingRetestToolName, string> = {
  get_finding_retests: "Reading retest history",
  start_finding_retest: "Starting retest record",
  complete_finding_retest: "Saving Agent assessment",
};

const OUTCOME_LABELS: Record<string, string> = {
  reproduced: "Reproduced",
  not_reproduced: "Not reproduced",
  inconclusive: "Inconclusive",
};

const OUTCOME_DOTS: Record<string, string> = {
  reproduced: "bg-red-500",
  not_reproduced: "bg-emerald-500",
  inconclusive: "bg-amber-500",
};

/** Fixed copy per server error code; tool messages and inputs are never shown. */
function failureContent(
  toolName: FindingRetestToolName,
  toolCallId: string,
  error: unknown,
): SidebarToolError {
  const saving = toolName === "complete_finding_retest";
  const starting = toolName === "start_finding_retest";
  const summaries: Record<string, string> = {
    unavailable: "Finding retests aren't available for this account.",
    not_found: saving
      ? "No retest started by this response was found for the report in this chat."
      : "The report isn't available in this chat.",
    conflict: saving
      ? "The report changed during the retest, or an assessment was already saved. Nothing was overwritten."
      : "The report changed after HackerAI read it. No retest was started.",
    not_active: "This Agent run can't be tracked, so no retest was recorded.",
    busy: "Another retest of this report is still running in this task.",
    rate_limited:
      "The hourly retest limit was reached. No retest was recorded.",
    already_finished:
      "This response already recorded a retest for this report.",
    validation:
      "The assessment didn't meet the requirements, such as redacting secrets or stating limitations. Nothing was saved.",
    interrupted:
      "The run that started this retest ended first. It was recorded as Inconclusive.",
  };
  const reason = typeof error === "string" ? error : "";
  const summary =
    summaries[reason] ??
    (saving
      ? "The assessment couldn't be confirmed. It may already be saved."
      : starting
        ? "The retest couldn't be recorded because of a temporary error."
        : "Retest history couldn't be read.");
  return {
    kind: "tool-error",
    errorKind:
      reason === "not_found"
        ? "not_found"
        : reason in summaries
          ? "validation"
          : "execution",
    isExecuting: false,
    toolName: "Finding retest",
    toolCallId,
    action: saving
      ? "Agent assessment wasn't saved"
      : starting
        ? "Retest wasn't started"
        : "Retest history unavailable",
    title: saving
      ? "The Agent assessment wasn't saved"
      : starting
        ? "The retest wasn't started"
        : "Retest history is unavailable",
    summary,
    nextStep:
      "Results stay in this chat. Open the report's Retest section to see what was recorded before retrying.",
  };
}

export const FindingRetestToolHandler = memo(function FindingRetestToolHandler({
  part,
  status,
  toolName,
}: {
  part: any;
  status: ChatStatus;
  toolName: FindingRetestToolName;
}) {
  const { toolCallId = "", state, input, output } = part;
  const result = output?.result ?? output;
  const icon = <RotateCcw aria-hidden="true" />;

  if (state === "input-streaming" || state === "input-available")
    return status === "streaming" ? (
      <ToolBlock icon={icon} action={WORKING[toolName]} isShimmer />
    ) : null;
  if (
    state === "output-error" ||
    (state === "output-available" && result?.success !== true)
  )
    return (
      <ToolErrorHandler
        content={failureContent(
          toolName,
          toolCallId,
          state === "output-error" ? undefined : result?.error,
        )}
      />
    );
  if (state !== "output-available") return null;

  if (toolName === "get_finding_retests") {
    const count = Array.isArray(result.retests) ? result.retests.length : 0;
    return (
      <ToolBlock
        icon={icon}
        action="Read retest history"
        target={
          count === 0
            ? "No earlier assessments"
            : `${count} recent Agent ${count === 1 ? "assessment" : "assessments"}`
        }
      />
    );
  }

  if (toolName === "start_finding_retest")
    return (
      <ToolBlock icon={icon} action="Retest started" target="Result pending" />
    );

  // On success the saved assessment is exactly this validated input.
  const outcome =
    typeof input?.outcome === "string" ? OUTCOME_LABELS[input.outcome] : null;
  const findingId =
    typeof input?.finding_id === "string" ? input.finding_id : null;
  return (
    <div className="space-y-2">
      <ToolBlock
        icon={icon}
        action="Agent assessment saved"
        target={outcome ?? undefined}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border px-3 py-2.5 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          {outcome ? (
            <span
              className={`size-2 shrink-0 rounded-full ${OUTCOME_DOTS[input.outcome]}`}
              aria-hidden="true"
            />
          ) : null}
          <span className="min-w-0 text-muted-foreground">
            {outcome ? (
              <span className="font-medium text-foreground">{outcome}</span>
            ) : null}
            {outcome ? " · " : null}
            Agent&apos;s judgment, saved to retest history. The report
            wasn&apos;t changed.
          </span>
        </span>
        {findingId ? (
          <Link
            href={`/findings?finding=${encodeURIComponent(findingId)}`}
            className="inline-flex shrink-0 items-center gap-1 rounded text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            View finding
            <ArrowUpRight
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
          </Link>
        ) : null}
      </div>
      {result.evidence_warning ? (
        <p className="text-xs text-muted-foreground">
          Some evidence files couldn&apos;t be checked and are marked
          unverified.
        </p>
      ) : null}
    </div>
  );
});
