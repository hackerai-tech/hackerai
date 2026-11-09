"use client";

import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { captureFindingEvent } from "@/lib/findings/client-telemetry";
import { downloadFindingsReport } from "@/lib/findings/export-client";
import type { FindingExportFormat } from "@/lib/findings/export";
import type { FindingDetailRecord } from "@/types/finding";

/** Thrown by getFindings when any requested finding no longer exists. */
export class FindingExportUnavailableError extends Error {
  constructor() {
    super("One or more findings are unavailable.");
    this.name = "FindingExportUnavailableError";
  }
}

const EXPORT_FORMATS: Array<{
  format: FindingExportFormat;
  label: string;
  hint: string;
}> = [
  { format: "markdown", label: "Markdown", hint: "Readable .md report" },
  { format: "pdf", label: "PDF", hint: "Printable document" },
  { format: "html", label: "HTML", hint: "Standalone web page" },
  { format: "json", label: "JSON", hint: "Structured records" },
  { format: "sarif", label: "SARIF 2.1", hint: "For code scanning tools" },
];

export function FindingExportMenu({
  getFindings,
  label = "Export report",
  disabled = false,
}: {
  getFindings: () => Promise<FindingDetailRecord[]>;
  label?: string;
  disabled?: boolean;
}) {
  const [busyFormat, setBusyFormat] = useState<FindingExportFormat | null>(
    null,
  );

  const handleExport = async (format: FindingExportFormat) => {
    if (busyFormat) return;
    setBusyFormat(format);
    captureFindingEvent({
      operation: "export",
      outcome: "initiated",
      phase: "request",
      format,
    });
    let resultCount: number | undefined;
    try {
      const findings = await getFindings();
      if (findings.length === 0) throw new FindingExportUnavailableError();
      resultCount = findings.length;
      const result = await downloadFindingsReport(findings, format);
      captureFindingEvent({
        operation: "export",
        phase: "save",
        ...result,
        format,
        result_count: findings.length,
        ...(findings.length === 1
          ? {
              finding_id: findings[0].finding_id,
              report_updated_at: findings[0].updated_at,
            }
          : {}),
      });
    } catch (error) {
      const unavailable = error instanceof FindingExportUnavailableError;
      captureFindingEvent({
        operation: "export",
        phase: "save",
        outcome: "failed",
        format,
        reason: unavailable ? "not_found" : "general",
        ...(resultCount !== undefined ? { result_count: resultCount } : {}),
      });
      toast.error(
        unavailable
          ? "Some findings are no longer available. Nothing was exported."
          : "Could not export report. Try again.",
      );
    } finally {
      setBusyFormat(null);
    }
  };

  const isBusy = busyFormat !== null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || isBusy}
            aria-busy={isBusy || undefined}
          >
            <Download className="size-4" aria-hidden="true" />
            {isBusy ? "Exporting…" : label}
            <ChevronDown
              className="size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Download as
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {EXPORT_FORMATS.map((item) => (
            <DropdownMenuItem
              key={item.format}
              disabled={isBusy}
              onSelect={() => void handleExport(item.format)}
              className="flex items-baseline justify-between gap-4"
            >
              <span className="font-medium">{item.label}</span>
              <span className="text-xs text-muted-foreground">{item.hint}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="sr-only" role="status" aria-live="polite">
        {isBusy ? "Preparing export…" : ""}
      </span>
    </>
  );
}
