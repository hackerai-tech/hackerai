import { toast } from "sonner";
import {
  isTauriEnvironment,
  revealFileInDir,
  saveFileToLocal,
  saveBinaryFileToLocal,
} from "@/app/hooks/useTauri";

/**
 * Options for file download/save operations.
 */
type DownloadContent = string | Uint8Array<ArrayBuffer>;

interface DownloadFileOptions {
  /** The suggested filename for the save dialog */
  filename: string;
  /**
   * UTF-8 text or exact binary bytes. Pass a loader when the content needs
   * network work: the browser save picker requires the click's transient
   * activation, so it opens first and the loader runs only after a
   * destination is chosen. Loader errors reject the call; nothing is written.
   */
  content: DownloadContent | (() => Promise<DownloadContent>);
  /** MIME type for the blob fallback (default: "text/plain") */
  mimeType?: string;
}

/**
 * Unified file download handler that works across Tauri desktop and web browsers.
 *
 * Strategy:
 * 1. Tauri: save via native dialog (anchor downloads don't work in WebView)
 * 2. File System Access API: native save dialog (Chrome/Edge)
 * 3. Blob download: traditional anchor element fallback
 */
export type DownloadFileResult = {
  outcome: "success" | "canceled" | "failed" | "initiated";
  reason?: "unsupported_native";
};

/** Keep the object URL alive while the browser starts its asynchronous save. */
export function startBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    link.remove();
  }
  // Revoking in the click's call stack can invalidate a pending download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadFile({
  filename,
  content,
  mimeType = "text/plain",
}: DownloadFileOptions): Promise<DownloadFileResult> {
  const load = async () =>
    typeof content === "function" ? content() : content;

  // Tauri: cancellation is a successful no-op, distinct from a failed write.
  // The native dialog has no activation requirement, so load first.
  if (isTauriEnvironment()) {
    const data = await load();
    try {
      const filePath =
        typeof data === "string"
          ? await saveFileToLocal(filename, data)
          : await saveBinaryFileToLocal(filename, data);
      if (filePath) {
        toast.success("File saved successfully", {
          action: {
            label: "Show in Finder",
            onClick: () => revealFileInDir(filePath),
          },
        });
      }
      return { outcome: filePath ? "success" : "canceled" };
    } catch (error) {
      const unsupported =
        typeof error === "string" &&
        /(?:command.*save_(?:binary_)?file_with_dialog.*not found|(?:command )?save_(?:binary_)?file_with_dialog not allowed(?: by acl)?)/i.test(
          error,
        );
      toast.error(
        unsupported ? "Update Desktop to save reports" : "Failed to save file",
      );
      return {
        outcome: "failed",
        ...(unsupported ? { reason: "unsupported_native" as const } : {}),
      };
    }
  }

  // File System Access API (native save dialog)
  if ("showSaveFilePicker" in window) {
    const failed = (err: unknown): DownloadFileResult => {
      // User cancelled the save dialog — not an error
      if (err instanceof DOMException && err.name === "AbortError") {
        return { outcome: "canceled" };
      }
      toast.error("Failed to save file");
      return { outcome: "failed" };
    };
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await (
        window as Window & {
          showSaveFilePicker: (options: {
            suggestedName: string;
          }) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName: filename,
      });
    } catch (err) {
      return failed(err);
    }
    const data = await load();
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
      toast.success("File saved successfully");
      return { outcome: "success" };
    } catch (err) {
      return failed(err);
    }
  }

  // Blob download fallback
  const data = await load();
  try {
    const blob = new Blob([data], { type: mimeType });
    startBlobDownload(blob, filename);
    toast.success("File downloaded successfully");
    return { outcome: "initiated" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { outcome: "canceled" };
    }
    toast.error("Failed to download file", {
      description:
        error instanceof Error ? error.message : "Unknown error occurred",
    });
    return { outcome: "failed" };
  }
}
