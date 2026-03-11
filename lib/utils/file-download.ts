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
 * 1. Tauri: save via command server (anchor downloads don't work in WebView)
 * 2. File System Access API: native save dialog (Chrome/Edge)
 * 3. Blob download: traditional anchor element fallback
 */
export async function downloadFile({
  filename,
  content,
  mimeType = "text/plain",
}: DownloadFileOptions): Promise<void> {
  // Tauri: save via command server
  if (isTauriEnvironment()) {
    const filePath = await saveFileToLocal(filename, content);
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
      return;
    }
  } catch (err) {
    // User cancelled the save dialog — not an error
    if (err instanceof DOMException && err.name === "AbortError") {
      return;
    }
    toast.error("Failed to save file");
    return;
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
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }
    toast.error("Failed to download file", {
      description:
        error instanceof Error ? error.message : "Unknown error occurred",
    });
  } finally {
    // Always revoke the blob URL to prevent memory leaks
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
}
