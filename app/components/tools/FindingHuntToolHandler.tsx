"use client";

import Link from "next/link";
import { memo, useEffect } from "react";
import { ArrowUpRight, ScanSearch } from "lucide-react";
import { notifyFindingHuntChanged } from "@/lib/findings/hunt-events";
import type { ChatStatus, SidebarToolError } from "@/types/chat";
import ToolBlock from "@/components/ui/tool-block";
import { ToolErrorHandler } from "./ToolErrorHandler";

export type FindingHuntToolName =
  | "get_finding_hunts"
  | "start_finding_hunt"
  | "record_finding_hunt_candidate"
  | "complete_finding_hunt";

const WORKING: Record<FindingHuntToolName, string> = {
  get_finding_hunts: "Reading similar issue hunts",
  start_finding_hunt: "Starting hunt record",
  record_finding_hunt_candidate: "Saving candidate assessment",
  complete_finding_hunt: "Saving hunt summary",
};

export const HUNT_OUTCOME_LABELS: Record<string, string> = {
  reproduced: "Reproduced",
  ruled_out: "Ruled out",
  inconclusive: "Inconclusive",
  not_examined: "Not examined",
};

const OUTCOME_DOTS: Record<string, string> = {
  reproduced: "bg-red-500",
  ruled_out: "bg-emerald-500",
  inconclusive: "bg-amber-500",
  not_examined: "border-[1.5px] border-muted-foreground/70",
};

const COUNT_ORDER = [
  "reproduced",
  "ruled_out",
  "inconclusive",
  "not_examined",
] as const;

/** Fixed copy per server error code; tool messages and inputs are never shown. */
function failureContent(
  toolName: FindingHuntToolName,
  toolCallId: string,
  error: unknown,
): SidebarToolError {
  const recording = toolName === "record_finding_hunt_candidate";
  const completing = toolName === "complete_finding_hunt";
  const starting = toolName === "start_finding_hunt";
  const saving = recording || completing;
  const summaries: Record<string, string> = {
    unavailable: "Similar issue hunts aren't available for this account.",
    not_found: saving
      ? "No hunt started by this response was found for the report in this chat."
      : "The report isn't available in this chat.",
    conflict: saving
      ? "The report changed during the hunt, or this was already saved differently. Nothing was overwritten."
      : "The report changed after HackerAI read it. No hunt was started.",
    not_active: "This Agent run can't be tracked, so no hunt was recorded.",
    busy: "Another hunt for this report is still running in this task.",
    rate_limited: "The hourly hunt limit was reached. No hunt was recorded.",
    already_finished: starting
      ? "This response already recorded a hunt for this report."
      : "This hunt is already complete. Nothing was changed.",
    limit_reached: "This hunt already has the maximum number of candidates.",
    validation:
      "The assessment didn't meet the requirements, such as redacting secrets, stating limitations or an honest evidence basis. Nothing was saved.",
    interrupted:
      "The run that started this hunt ended first. Candidates saved before then were kept.",
  };
  const reason = typeof error === "string" ? error : "";
  const summary =
    summaries[reason] ??
    (saving
      ? "The save couldn't be confirmed. It may already be saved."
      : starting
        ? "The hunt couldn't be recorded because of a temporary error."
        : "Hunt history couldn't be read.");
  const action = recording
    ? "Candidate wasn't saved"
    : completing
      ? "Hunt summary wasn't saved"
      : starting
        ? "Hunt wasn't started"
        : "Hunt history unavailable";
  return {
    kind: "tool-error",
    errorKind:
      reason === "not_found"
        ? "not_found"
        : reason in summaries
          ? "validation"
          : "execution",
    isExecuting: false,
    toolName: "Similar issue hunt",
    toolCallId,
    action,
    title: `The ${action.charAt(0).toLowerCase()}${action.slice(1)}`,
    summary,
    nextStep:
      "Results stay in this chat. Open the report's Similar issues tab to see what was recorded before retrying.",
  };
}

const findingHref = (input: any) =>
  typeof input?.finding_id === "string"
    ? `/findings?finding=${encodeURIComponent(input.finding_id)}`
    : null;

function FindingLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex shrink-0 items-center gap-1 rounded text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      View finding
      <ArrowUpRight
        className="size-3.5 text-muted-foreground"
        aria-hidden="true"
      />
    </Link>
  );
}

export const FindingHuntToolHandler = memo(function FindingHuntToolHandler({
  part,
  status,
  toolName,
}: {
  part: any;
  status: ChatStatus;
  toolName: FindingHuntToolName;
}) {
  const { toolCallId = "", state, input, output } = part;
  const result = output?.result ?? output;
  const icon = <ScanSearch aria-hidden="true" />;

  // A saved start, candidate or completion changes the finding's hunt
  // history; let a mounted finding view refresh. A remounted historical part
  // may notify once more, which only causes one harmless read.
  const changedFindingId =
    toolName !== "get_finding_hunts" &&
    state === "output-available" &&
    result?.success === true &&
    typeof input?.finding_id === "string"
      ? (input.finding_id as string)
      : null;
  useEffect(() => {
    if (changedFindingId) notifyFindingHuntChanged(changedFindingId);
  }, [changedFindingId, toolCallId]);

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

  if (toolName === "get_finding_hunts") {
    const count = Array.isArray(result.hunts) ? result.hunts.length : 0;
    return (
      <ToolBlock
        icon={icon}
        action="Read similar issue hunts"
        target={
          count === 0
            ? "No earlier hunts"
            : `${count} recent ${count === 1 ? "hunt" : "hunts"}`
        }
      />
    );
  }

  if (toolName === "start_finding_hunt")
    return (
      <ToolBlock icon={icon} action="Hunt started" target="Results pending" />
    );

  if (toolName === "record_finding_hunt_candidate") {
    // On success the saved candidate is exactly this validated input.
    const outcome =
      typeof input?.outcome === "string"
        ? HUNT_OUTCOME_LABELS[input.outcome]
        : undefined;
    return <ToolBlock icon={icon} action="Candidate saved" target={outcome} />;
  }

  const counts = result.counts ?? {};
  const href = findingHref(input);
  const tally = COUNT_ORDER.filter((key) => (counts[key] ?? 0) > 0);
  return (
    <div className="space-y-2">
      <ToolBlock icon={icon} action="Hunt saved" />
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border px-3 py-2.5 text-sm">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {tally.length === 0 ? (
            <span className="text-muted-foreground">No candidates saved</span>
          ) : (
            tally.map((key) => (
              <span key={key} className="inline-flex items-center gap-1.5">
                <span
                  className={`size-2 shrink-0 rounded-full ${OUTCOME_DOTS[key]}`}
                  aria-hidden="true"
                />
                <span className="text-foreground">
                  {counts[key]} {HUNT_OUTCOME_LABELS[key].toLowerCase()}
                </span>
              </span>
            ))
          )}
          <span className="text-muted-foreground">
            Agent&apos;s judgment. Not findings; the report wasn&apos;t changed.
          </span>
        </span>
        {href ? <FindingLink href={href} /> : null}
      </div>
    </div>
  );
});
