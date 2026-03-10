import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Download, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import {
  isTauriEnvironment,
  saveFileToLocal,
  revealFileInDir,
} from "@/app/hooks/useTauri";

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

function toCSV(data: string[][]): string {
  return data
    .map((row) =>
      row
        .map((cell) => {
          if (cell.includes(",") || cell.includes('"') || cell.includes("\n")) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          return cell;
        })
        .join(","),
    )
    .join("\n");
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
    try {
      const tableEl = wrapperRef.current?.querySelector("table");
      const tsv = data.map((row) => row.join("\t")).join("\n");
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([tsv], { type: "text/plain" }),
          ...(tableEl
            ? {
                "text/html": new Blob([tableEl.outerHTML], {
                  type: "text/html",
                }),
              }
            : {}),
        }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback to plain text copy
      try {
        const tsv = data.map((row) => row.join("\t")).join("\n");
        await navigator.clipboard.writeText(tsv);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy table:", err);
      }
    }
  };

  const handleDownload = async () => {
    const data = getTableData();
    if (!data) return;
    const csv = toCSV(data);
    const filename = "table.csv";

    if (isTauriEnvironment()) {
      const filePath = await saveFileToLocal(filename, csv);
      if (filePath) {
        toast.success(`Saved ${filename}`, {
          action: {
            label: "Show in Finder",
            onClick: () => revealFileInDir(filePath),
          },
        });
      } else {
        toast.error("Failed to save file");
      }
      return;
    }

    // Web: standard download
    try {
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Table downloaded");
    } catch {
      toast.error("Failed to download table");
    }
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
