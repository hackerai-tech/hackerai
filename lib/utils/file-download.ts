import { toast } from "sonner";
import {
  isTauriEnvironment,
  revealFileInDir,
  saveFileToLocal,
} from "@/app/hooks/useTauri";

/**
 * Options for file download/save operations.
 */
interface DownloadFileOptions {
  /** The suggested filename for the save dialog */
  filename: string;
  /** The file content as a string */
  content: string;
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

export async function downloadFile({
  filename,
  content,
  mimeType = "text/plain",
}: DownloadFileOptions): Promise<DownloadFileResult> {
  // Tauri: cancellation is a successful no-op, distinct from a failed write.
  if (isTauriEnvironment()) {
    try {
      const filePath = await saveFileToLocal(filename, content);
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
        /command.*save_file_with_dialog.*not found/i.test(error);
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
  try {
    if ("showSaveFilePicker" in window) {
      const fileHandle = await (
        window as Window & {
          showSaveFilePicker: (options: {
            suggestedName: string;
          }) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName: filename,
      });

      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      toast.success("File saved successfully");
      return { outcome: "success" };
    }
  } catch (err) {
    // User cancelled the save dialog — not an error
    if (err instanceof DOMException && err.name === "AbortError") {
      return { outcome: "canceled" };
    }
    toast.error("Failed to save file");
    return { outcome: "failed" };
  }

  // Blob download fallback
  let url: string | undefined;
  try {
    const blob = new Blob([content], { type: mimeType });
    url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
  } finally {
    // Always revoke the blob URL to prevent memory leaks
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
}
