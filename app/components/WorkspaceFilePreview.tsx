"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { marked } from "marked";
import { ComputerCodeBlock as Code } from "./ComputerCodeBlock";
import { Copy, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  filePreviewDelimiter,
  parseDelimitedPreview,
} from "@/lib/workspace-preview/delimited-preview";
import {
  workspaceLanguage,
  workspacePreviewDocument,
} from "@/lib/workspace-preview/format";

export type WorkspacePreview = {
  name: string;
  path: string;
  text?: string;
  url?: string;
};

/**
 * `compact` is for phone layouts whose header already shows the file name and
 * back navigation: it omits both, enlarges touch targets, and lets rendered
 * documents fill the remaining height.
 */
export default function WorkspaceFilePreview({
  file,
  onClose,
  onDownload,
  busy,
  partial = false,
  compact = false,
}: {
  file: WorkspacePreview;
  onClose: () => void;
  onDownload: () => void;
  busy: boolean;
  partial?: boolean;
  compact?: boolean;
}) {
  const [source, setSource] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const markdown = /\.(md|markdown)$/i.test(file.name);
  const html = /\.html?$/i.test(file.name);
  const delimiter = filePreviewDelimiter(file);
  const hasRendered = markdown || html || !!delimiter;
  const document = useMemo(() => {
    if (source || file.text === undefined || (!markdown && !html))
      return undefined;
    return workspacePreviewDocument(
      markdown ? marked.parse(file.text, { async: false }) : file.text,
    );
  }, [file.text, markdown, html, source]);
  const table = useMemo(
    () =>
      !source && delimiter && file.text !== undefined
        ? parseDelimitedPreview(file.text, delimiter)
        : null,
    [file.text, delimiter, source],
  );
  const text = useMemo(() => {
    if (!/\.json$/i.test(file.name) || source || file.text === undefined)
      return file.text;
    try {
      return JSON.stringify(JSON.parse(file.text), null, 2);
    } catch {
      return file.text;
    }
  }, [file.name, file.text, source]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file.text ?? "");
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(
        "Copy unavailable. Select the source text or download the file.",
      );
    }
  };
  return (
    <section
      aria-label={`Preview ${file.name}`}
      className="flex min-h-48 flex-1 flex-col overflow-hidden rounded-lg border bg-background"
    >
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        {!compact && (
          <span
            title={file.path}
            className="min-w-0 flex-1 truncate text-sm font-medium"
          >
            {file.name}
          </span>
        )}
        {(hasRendered || /\.json$/i.test(file.name)) && (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={!source ? "secondary" : "ghost"}
              className={compact ? "h-11 px-4" : undefined}
              aria-pressed={!source}
              onClick={() => setSource(false)}
            >
              {hasRendered ? "Preview" : "Formatted"}
            </Button>
            <Button
              size="sm"
              variant={source ? "secondary" : "ghost"}
              className={compact ? "h-11 px-4" : undefined}
              aria-pressed={source}
              onClick={() => setSource(true)}
            >
              Source
            </Button>
          </div>
        )}
        <div className="ml-auto flex gap-1">
          {file.text !== undefined && (
            <Button
              size="icon"
              variant="ghost"
              className={compact ? "size-11" : undefined}
              aria-label="Copy file contents"
              onClick={() => void copy()}
            >
              <Copy size={compact ? 16 : 14} />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className={compact ? "size-11" : undefined}
            aria-label={
              partial ? "Download captured excerpt" : "Download previewed file"
            }
            disabled={busy}
            onClick={onDownload}
          >
            <Download size={compact ? 16 : 14} />
          </Button>
          {!compact && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close file preview"
              onClick={onClose}
            >
              <X size={14} />
            </Button>
          )}
        </div>
      </div>
      <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span className="sr-only">File path: </span>
        <span
          className="block overflow-x-auto whitespace-nowrap"
          title={file.path}
        >
          {file.path}
        </span>
      </div>
      {copyStatus && (
        <p role="status" className="px-3 text-xs">
          {copyStatus}
        </p>
      )}
      <div
        className={`min-h-0 flex-1 overflow-auto ${compact && document ? "flex flex-col" : ""}`}
      >
        {file.url ? (
          <Image
            unoptimized
            width={1200}
            height={800}
            src={file.url}
            alt={file.name}
            className="max-h-96 max-w-full object-contain p-3"
          />
        ) : document ? (
          <>
            <p className="p-2 text-xs text-muted-foreground">
              Static preview. Scripts, links and external resources are
              disabled.
            </p>
            <iframe
              title={`Rendered ${file.name}`}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={document}
              className={`w-full border-0 bg-white ${compact ? "min-h-60 flex-1" : "h-80"}`}
            />
          </>
        ) : table ? (
          <>
            <table
              aria-label={`Table ${file.name}`}
              className="w-full border-collapse text-left text-xs"
            >
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) =>
                      i === 0 ? (
                        <th
                          key={j}
                          className="border bg-muted p-2 whitespace-pre-wrap break-words"
                        >
                          {cell}
                        </th>
                      ) : (
                        <td
                          key={j}
                          className="max-w-80 border p-2 whitespace-pre-wrap break-words"
                        >
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {table.truncated && (
              <p role="status" className="p-3 text-xs">
                Table preview limited to 100 rows, 30 columns and 2,000
                characters per cell. Source and download retain the{" "}
                {partial ? "captured excerpt" : "full file"}.
              </p>
            )}
          </>
        ) : (
          <Code
            language={
              (text?.length ?? 0) <= 50_000
                ? workspaceLanguage(file.name)
                : "text"
            }
            showButtons={false}
          >
            {text ?? ""}
          </Code>
        )}
      </div>
    </section>
  );
}
