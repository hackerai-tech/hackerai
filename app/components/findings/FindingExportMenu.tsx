"use client";

import { useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
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

/**
 * The one export flow for findings: download, telemetry, errors and a busy
 * guard. Keep the hook in a component that stays mounted while a menu closes,
 * so every entry point shares the guard and the status announcement.
 */
export function useFindingExport(
  getFindings: () => Promise<FindingDetailRecord[]>,
) {
  const [busyFormat, setBusyFormat] = useState<FindingExportFormat | null>(
    null,
  );
  // A ref closes the double-submit window before the busy state re-renders.
  const busy = useRef(false);

  const exportAs = async (format: FindingExportFormat) => {
    if (busy.current) return;
    busy.current = true;
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
      busy.current = false;
      setBusyFormat(null);
    }
  };

  return { busyFormat, isBusy: busyFormat !== null, exportAs };
}

export type FindingExporter = ReturnType<typeof useFindingExport>;

export function FindingExportStatus({
  exporter,
}: {
  exporter: FindingExporter;
}) {
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {exporter.isBusy ? "Preparing export…" : ""}
    </span>
  );
}

/** Keys that open a Radix dropdown trigger. */
const MENU_OPEN_KEYS = new Set(["Enter", " ", "ArrowDown"]);

const FormatItems = ({ exporter }: { exporter: FindingExporter }) =>
  EXPORT_FORMATS.map((item) => (
    <DropdownMenuItem
      key={item.format}
      disabled={exporter.isBusy}
      onSelect={() => void exporter.exportAs(item.format)}
      className="flex items-baseline justify-between gap-4"
    >
      <span className="font-medium">{item.label}</span>
      <span className="text-xs text-muted-foreground">{item.hint}</span>
    </DropdownMenuItem>
  ));

/**
 * Export formats in a small dialog, for narrow panels where a nested menu
 * flyout can't fit. Shares the caller's exporter; it stays open while the
 * export runs and closes when it settles. `returnFocusTo` receives focus on
 * close, because the menu item that opened the dialog no longer exists.
 */
export function FindingExportDialog({
  exporter,
  open,
  onOpenChange,
  returnFocusTo,
}: {
  exporter: FindingExporter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}) {
  const firstFormat = useRef<HTMLButtonElement>(null);
  const { isBusy } = exporter;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto overscroll-contain sm:max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          firstFormat.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo?.current) return;
          event.preventDefault();
          returnFocusTo.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Export report</DialogTitle>
          <DialogDescription>Download this finding as:</DialogDescription>
        </DialogHeader>
        <ul className="-mx-2">
          {EXPORT_FORMATS.map((item, index) => (
            <li key={item.format}>
              {/* aria-disabled keeps focus on the row while an export runs. */}
              <button
                ref={index === 0 ? firstFormat : undefined}
                type="button"
                aria-disabled={isBusy || undefined}
                onClick={() => {
                  if (isBusy) return;
                  void exporter
                    .exportAs(item.format)
                    .then(() => onOpenChange(false));
                }}
                className="flex min-h-11 w-full items-baseline justify-between gap-4 rounded-md px-2 py-2.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
              >
                <span className="font-medium text-foreground">
                  {item.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.hint}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="min-h-5 text-sm text-muted-foreground" role="status">
          {isBusy ? "Preparing export…" : ""}
        </p>
      </DialogContent>
    </Dialog>
  );
}

export function FindingExportMenu({
  getFindings,
  label = "Export report",
  disabled = false,
  variant = "outline",
  align = "start",
  exporter: sharedExporter,
}: {
  getFindings: () => Promise<FindingDetailRecord[]>;
  label?: string;
  disabled?: boolean;
  variant?: "outline" | "default";
  align?: "start" | "end";
  /** Share busy state with another export entry point; its owner announces status. */
  exporter?: FindingExporter;
}) {
  const ownExporter = useFindingExport(getFindings);
  const exporter = sharedExporter ?? ownExporter;
  const { isBusy } = exporter;

  return (
    <>
      <DropdownMenu>
        {/* While busy the trigger stays focusable, so the closing menu can
            return focus to it, but it doesn't open the menu. */}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={variant}
            size="sm"
            disabled={disabled}
            aria-disabled={isBusy || undefined}
            aria-busy={isBusy || undefined}
            onPointerDown={(event) => {
              if (isBusy) event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (isBusy && MENU_OPEN_KEYS.has(event.key))
                event.preventDefault();
            }}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            <Download className="size-4" aria-hidden="true" />
            {isBusy ? "Exporting…" : label}
            <ChevronDown
              className={cn(
                "size-3.5",
                variant === "outline" ? "text-muted-foreground" : "opacity-60",
              )}
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="min-w-56">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Download as
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <FormatItems exporter={exporter} />
        </DropdownMenuContent>
      </DropdownMenu>
      {sharedExporter ? null : <FindingExportStatus exporter={exporter} />}
    </>
  );
}
