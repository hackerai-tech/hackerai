"use client";

import Link from "next/link";
import { memo } from "react";
import { FileSearch } from "lucide-react";
import type { ChatStatus } from "@/types/chat";
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
    return (
      <div className="space-y-2">
        <ToolBlock
          icon={<FileSearch aria-hidden="true" />}
          action={`Listed ${reports.length} saved ${reports.length === 1 ? "report" : "reports"}`}
          target="Current chat"
        />
        {reports.length > 0 && (
          <ul
            aria-label="Reports in this chat"
            className="space-y-2 rounded-lg border border-border p-3 text-sm"
          >
            {reports.map((report: any) => (
              <li
                key={report.finding_id}
                className="flex items-start justify-between gap-3"
              >
                <Link
                  className="min-w-0 break-words text-link hover:underline"
                  href={`/findings?finding=${encodeURIComponent(report.finding_id)}`}
                >
                  {report.title}
                </Link>
                <span className="shrink-0 text-xs capitalize text-muted-foreground">
                  {report.severity}
                </span>
              </li>
            ))}
          </ul>
        )}
        {result.is_done === false && (
          <p className="text-xs text-muted-foreground">
            More reports are available in this chat.
          </p>
        )}
      </div>
    );
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
