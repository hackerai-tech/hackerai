import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Download, Copy, Check } from "lucide-react";
import { downloadFile } from "@/lib/utils/file-download";
import {
  neutralizeSpreadsheetFormula,
  serializeSpreadsheetCsv,
  serializeSpreadsheetTsv,
} from "@/lib/utils/spreadsheet-export";

function extractTableData(tableEl: HTMLTableElement): string[][] {
  const rows: string[][] = [];
  for (const row of Array.from(tableEl.rows)) {
    const cells: string[] = [];
    for (const cell of Array.from(row.cells)) {
      cells.push(cell.textContent?.trim() || "");
    }
    rows.push(cells);
  }
  return rows;
}

function serializeSpreadsheetTableHtml(tableEl: HTMLTableElement): string {
  const clone = tableEl.cloneNode(true) as HTMLTableElement;

  for (const cell of Array.from(clone.querySelectorAll("th, td"))) {
    const value = cell.textContent || "";
    if (neutralizeSpreadsheetFormula(value) !== value) {
      cell.insertBefore(document.createTextNode("'"), cell.firstChild);
    }
  }

  return clone.outerHTML;
}

interface MarkdownTableProps {
  children?: ReactNode;
  className?: string;
  node?: unknown;
}

export function MarkdownTable({
  children,
  className,
  node: _node,
  ...props
}: MarkdownTableProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const getTableData = () => {
    const tableEl = wrapperRef.current?.querySelector("table");
    if (!tableEl) return null;
    return extractTableData(tableEl);
  };

  const handleCopy = async () => {
    const data = getTableData();
    if (!data) return;
    const tsv = serializeSpreadsheetTsv(data);
    try {
      const tableEl = wrapperRef.current?.querySelector("table");
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([tsv], { type: "text/plain" }),
          ...(tableEl
            ? {
                "text/html": new Blob(
                  [serializeSpreadsheetTableHtml(tableEl)],
                  { type: "text/html" },
                ),
              }
            : {}),
        }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback to plain text copy
      try {
        await navigator.clipboard.writeText(tsv);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy table:", err);
      }
    }
  };

  const handleDownload = () => {
    const data = getTableData();
    if (!data) return;
    downloadFile({
      filename: "table.csv",
      content: serializeSpreadsheetCsv(data),
      mimeType: "text/csv",
    });
  };

  return (
    <div
      ref={wrapperRef}
      className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
      data-streamdown="table-wrapper"
    >
      <div className="flex items-center justify-end gap-1">
        <button
          className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground"
          onClick={handleDownload}
          title="Download as CSV"
          type="button"
        >
          <Download size={14} />
        </button>
        <button
          className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground"
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy table"}
          type="button"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div className="border-collapse overflow-x-auto overscroll-y-auto rounded-md border border-border bg-background">
        <table
          className={`w-full divide-y divide-border ${className || ""}`}
          data-streamdown="table"
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
}
