"use client";

import Link from "next/link";
import { memo, useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { FileSearch } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { ChatStatus } from "@/types/chat";
import type { FindingSummary } from "@/types/finding";
import { cn } from "@/lib/utils";
import { findingStatusLabel } from "@/lib/findings/disposition";
import { getFindingSeverityDotClasses } from "@/app/components/findings/FindingCard";
import { FindingStatusPill } from "@/app/components/findings/FindingDecision";
import { FindingEvidenceBadge } from "@/app/components/findings/FindingEvidenceBadge";
import ToolBlock from "@/components/ui/tool-block";
import { SavedFindingCard } from "./FindingToolHandler";
import {
  ToolErrorHandler,
  ToolValidationErrorHandler,
} from "./ToolErrorHandler";
import {
  createReportToolFailureContent,
  isToolInputValidationError,
} from "@/lib/chat/tool-error-display";

type ReportToolName =
  "list_reports" | "get_report" | "update_vulnerability_report";

const MAX_LIVE_REPORTS = 25;

/**
 * A list result is a transcript snapshot. Rehydrate only its exact recorded
 * IDs from the owner's current records; never present snapshot severity or
 * status as current, and never look reports up by title.
 */
function ReportList({ reports, isDone }: { reports: any[]; isDone: boolean }) {
  const snapshots = useMemo(() => {
    const byId = new Map<string, string>();
    for (const report of reports) {
      if (typeof report?.finding_id !== "string" || !report.finding_id)
        continue;
      if (byId.size >= MAX_LIVE_REPORTS) break;
      if (!byId.has(report.finding_id))
        byId.set(
          report.finding_id,
          typeof report.title === "string" ? report.title : "Saved report",
        );
    }
    return byId;
  }, [reports]);
  const queries = useMemo<RequestForQueries>(
    (): RequestForQueries =>
      snapshots.size > 0
        ? {
            summaries: {
              query: api.findings.getFindingSummaries,
              args: { findingIds: [...snapshots.keys()] },
            },
          }
        : {},
    [snapshots],
  );
  const { summaries } = useQueries(queries) as {
    summaries?: FindingSummary[] | Error;
  };
  const current = Array.isArray(summaries)
    ? new Map(summaries.map((summary) => [summary.finding_id, summary]))
    : undefined;

  return (
    <div className="space-y-2">
      <ToolBlock
        icon={<FileSearch aria-hidden="true" />}
        action={`Listed ${reports.length} saved ${reports.length === 1 ? "report" : "reports"}`}
        target="Current chat"
      />
      {snapshots.size > 0 && (
        <ul
          aria-label="Reports in this chat"
          className="divide-y divide-border rounded-lg border border-border px-3 text-sm"
        >
          {[...snapshots].map(([findingId, snapshotTitle]) => {
            const summary = current?.get(findingId);
            const href = `/findings?finding=${encodeURIComponent(findingId)}`;
            if (current && !summary)
              return (
                <li
                  key={findingId}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2.5"
                >
                  <span className="min-w-0 break-words text-muted-foreground">
                    {snapshotTitle}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    No longer available
                  </span>
                </li>
              );
            if (!summary)
              return (
                <li key={findingId} className="py-2.5">
                  <Link
                    className="min-w-0 break-words text-link hover:underline"
                    href={href}
                  >
                    {snapshotTitle}
                  </Link>
                </li>
              );
            return (
              <li key={findingId} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link
                    className="break-words font-medium text-link hover:underline"
                    href={href}
                  >
                    {summary.title}
                  </Link>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <FindingStatusPill
                      disposition={summary.disposition}
                      label={findingStatusLabel(summary, summary.disposition)}
                    />
                    <FindingEvidenceBadge status={summary.evidence_status} />
                  </div>
                  {summary.disposition ? (
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground/90">
                      {summary.disposition.reason}
                    </p>
                  ) : null}
                </div>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs tabular-nums",
                    summary.status === "closed"
                      ? "text-muted-foreground"
                      : "text-foreground/90",
                  )}
                >
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      summary.status === "closed"
                        ? "bg-muted-foreground/50"
                        : getFindingSeverityDotClasses(summary.severity),
                    )}
                    aria-hidden="true"
                  />
                  <span className="capitalize">{summary.severity}</span> ·{" "}
                  {summary.cvss_score.toFixed(1)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {summaries instanceof Error && (
        <p role="alert" className="text-xs text-muted-foreground">
          Current report details are temporarily unavailable.
        </p>
      )}
      {!isDone && (
        <p className="text-xs text-muted-foreground">
          More reports are available in this chat.
        </p>
      )}
    </div>
  );
}

export const ReportToolHandler = memo(function ReportToolHandler({
  part,
  status,
  toolName,
}: {
  part: any;
  status: ChatStatus;
  toolName: ReportToolName;
}) {
  const { toolCallId = "", state, output, errorText } = part;
  const result = output?.result ?? output;
  const operation =
    toolName === "list_reports"
      ? "list"
      : toolName === "get_report"
        ? "get"
        : "update";
  const working =
    operation === "list"
      ? "Listing saved reports"
      : operation === "get"
        ? "Reading vulnerability report"
        : "Updating vulnerability report";
  if (state === "input-streaming" || state === "input-available")
    return status === "streaming" ? (
      <ToolBlock
        icon={<FileSearch aria-hidden="true" />}
        action={working}
        isShimmer
      />
    ) : null;
  if (state === "output-error" && isToolInputValidationError(errorText))
    return (
      <ToolValidationErrorHandler
        toolType={`tool-${toolName}`}
        toolCallId={toolCallId}
        errorText={errorText}
      />
    );
  if (
    state === "output-error" ||
    (state === "output-available" && result?.success !== true)
  )
    return (
      <ToolErrorHandler
        content={createReportToolFailureContent({
          toolCallId,
          operation,
          reason:
            result?.validation_kind === "evidence" ? "evidence" : result?.error,
        })}
      />
    );
  if (state !== "output-available") return null;
  if (operation === "list") {
    const reports = Array.isArray(result.reports) ? result.reports : [];
    return <ReportList reports={reports} isDone={result.is_done !== false} />;
  }
  const report = operation === "get" ? result.report : result;
  if (
    !report?.finding_id ||
    !report.title ||
    !report.target ||
    !report.severity ||
    typeof report.cvss_score !== "number"
  )
    return (
      <ToolErrorHandler
        content={createReportToolFailureContent({ toolCallId, operation })}
      />
    );
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {operation === "get" ? "Saved report" : "Report updated"}
      </p>
      <SavedFindingCard output={report} toolCallId={toolCallId} />
    </div>
  );
});
