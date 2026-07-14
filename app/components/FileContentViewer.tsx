import { Download, FileText, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isPdfFile, isTextViewableFile } from "@/lib/utils/file-utils";
import { LocalDesktopFile } from "@/types/file";
import { useFileUrlCacheContext } from "../contexts/FileUrlCacheContext";

const isBrowserFile = (file: File | LocalDesktopFile): file is File =>
  typeof globalThis.File !== "undefined" && file instanceof globalThis.File;

/** Guard against freezing the UI on very large text files */
const MAX_PREVIEW_CHARS = 500_000;
const PDF_MAGIC_BYTES = "%PDF-";

async function hasPdfMagicBytes(file: File): Promise<boolean> {
  const header = await file.slice(0, PDF_MAGIC_BYTES.length).text();
  return header === PDF_MAGIC_BYTES;
}

interface FileContentViewerProps {
  isOpen: boolean;
  onClose: () => void;
  file: File | LocalDesktopFile;
  fileName: string;
  /**
   * S3 file id for attachments restored from a draft after reload, where the
   * in-memory File (and its content) is no longer available.
   */
  fileId?: string;
}

export const FileContentViewer = ({
  isOpen,
  onClose,
  file,
  fileName,
  fileId,
}: FileContentViewerProps) => {
  const getFileUrlAction = useAction(api.s3Actions.getFileUrlAction);
  const fileUrlCache = useFileUrlCacheContext();
  const [content, setContent] = useState<string>("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<boolean>(false);

  const resolveFileUrl = useCallback(
    async (id: string): Promise<string | null> => {
      const cachedUrl = fileUrlCache?.getCachedUrl(id);
      if (cachedUrl) return cachedUrl;

      const url = await getFileUrlAction({ fileId: id as Id<"files"> });
      if (url) fileUrlCache?.setCachedUrl(id, url);
      return url;
    },
    [fileUrlCache, getFileUrlAction],
  );

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    // Blob URL created for in-memory PDF previews; must be revoked on cleanup.
    let createdBlobUrl: string | null = null;

    const loadContent = async () => {
      setIsLoading(true);
      setError(null);
      setTruncated(false);
      setPdfUrl(null);
      setContent("");

      const pdf = isPdfFile(file);

      // Previewability is based on name/media type, so it works for both real
      // browser Files and the metadata-only descriptor restored from a draft.
      // Without an in-memory File or an S3 file id there is nothing to read.
      if (
        (!pdf && !isTextViewableFile(file)) ||
        (!isBrowserFile(file) && !fileId)
      ) {
        if (!cancelled) {
          setError("Preview isn't available for this file type.");
          setIsLoading(false);
        }
        return;
      }

      try {
        if (pdf) {
          // Render via the browser's native PDF viewer. In-memory files use a
          // blob URL; restored-from-draft files use a short-lived signed URL.
          let url: string;
          if (isBrowserFile(file)) {
            if (!(await hasPdfMagicBytes(file))) {
              throw new Error("Invalid PDF signature");
            }
            createdBlobUrl = URL.createObjectURL(file);
            url = createdBlobUrl;
          } else {
            const signedUrl = await resolveFileUrl(fileId!);
            if (!signedUrl) throw new Error("Could not resolve file URL");
            url = signedUrl;
          }

          if (cancelled) {
            if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
            return;
          }

          setPdfUrl(url);
          return;
        }

        let text: string;

        if (isBrowserFile(file)) {
          text = await file.text();
        } else {
          // Restored-from-draft attachment: fetch content from storage using a
          // short-lived signed URL keyed by the file id.
          const url = await resolveFileUrl(fileId!);
          if (!url) throw new Error("Could not resolve file URL");

          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Failed to fetch file (${response.status})`);
          }
          text = await response.text();
        }

        if (cancelled) return;

        if (text.length > MAX_PREVIEW_CHARS) {
          setContent(text.slice(0, MAX_PREVIEW_CHARS));
          setTruncated(true);
        } else {
          setContent(text);
        }
      } catch {
        if (!cancelled) setError("Failed to read file content.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadContent();

    return () => {
      cancelled = true;
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
    };
  }, [isOpen, file, fileId, resolveFileUrl]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleDownload = useCallback(async () => {
    if (isBrowserFile(file)) {
      const blobUrl = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
      return;
    }

    if (fileId) {
      const url = await resolveFileUrl(fileId);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    }
  }, [file, fileName, fileId, resolveFileUrl]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!isOpen) return null;

  const canDownload = isBrowserFile(file) || !!fileId;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${fileName}`}
        className="pointer-events-auto flex h-[calc(100vh-32px)] w-[calc(100vw-32px)] max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-[0px_0px_8px_0px_rgba(0,0,0,0.02)] md:h-[calc(100vh-80px)] md:w-[calc(100vw-80px)]"
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
            <div className="flex size-9 shrink-0 items-center justify-center">
              <FileText className="size-5" aria-hidden="true" />
            </div>
            <span
              className="truncate text-sm font-medium leading-5 text-foreground"
              title={fileName}
            >
              {fileName}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {canDownload && (
              <button
                type="button"
                onClick={handleDownload}
                aria-label="Download file"
                className="flex size-8 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-accent"
              >
                <Download
                  className="size-[18px] text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close file preview"
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-accent"
            >
              <X
                className="size-[18px] text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          </div>
        </header>

        <div className="relative flex min-h-0 w-full flex-1">
          {isLoading ? (
            <div className="flex h-full w-full items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
              <FileText
                className="size-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="text-sm text-muted-foreground">{error}</p>
              {canDownload && (
                <button
                  type="button"
                  onClick={handleDownload}
                  className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
                >
                  <Download className="size-4" aria-hidden="true" />
                  Download
                </button>
              )}
            </div>
          ) : pdfUrl ? (
            // Chromium's PDF viewer can fail inside sandboxed iframes. The PDF
            // path is gated above by MIME type and magic bytes before blob URL creation.
            <iframe
              src={pdfUrl}
              title={`Preview of ${fileName}`}
              className="h-full w-full border-0"
            />
          ) : (
            <div
              className="w-full overflow-auto px-4 py-[15px] font-mono text-xs leading-[18px] text-foreground"
              style={{
                overflowWrap: "break-word",
                wordBreak: "normal",
                whiteSpace: "pre-wrap",
              }}
            >
              <pre className="max-w-full whitespace-pre-wrap">{content}</pre>
              {truncated && (
                <p className="mt-4 text-xs italic text-muted-foreground">
                  Preview truncated — download the file to view its full
                  contents.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
