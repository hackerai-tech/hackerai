import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import type { LocalDesktopFile } from "@/types/file";
import {
  getLocalFileMetadata,
  isTauriEnvironment,
  pickLocalFiles,
} from "../hooks/useTauri";
import { FileContentViewer } from "./FileContentViewer";

/** Saved messages retain names, not local paths. The user reselects the file. */
export function LocalFilePreviewCard({ fileName }: { fileName: string }) {
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<{
    file: LocalDesktopFile;
    path: string;
  } | null>(null);

  async function locateFile() {
    if (!isTauriEnvironment()) {
      toast.info(
        "Open this task in HackerAI Desktop to locate the local file.",
      );
      return;
    }
    setLoading(true);
    try {
      const paths = await pickLocalFiles();
      if (!paths.length) return;
      if (paths.length !== 1) {
        toast.error("Select one file to preview.");
        return;
      }
      const metadata = await getLocalFileMetadata(paths[0]);
      if (!metadata) return;
      if (metadata.name !== fileName) {
        toast.error(`Select ${fileName} to preview this attachment.`);
        return;
      }
      setSelection({
        path: metadata.path,
        file: {
          name: metadata.name,
          type: metadata.mediaType,
          size: metadata.size,
          lastModified: metadata.lastModified,
        },
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={locateFile}
        disabled={loading}
        aria-label={`Locate ${fileName} to preview`}
        className="flex w-full min-w-64 max-w-80 items-center gap-2 rounded-lg border bg-background p-2 text-left hover:bg-secondary disabled:opacity-50"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#FF5588] text-white">
          {loading ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : (
            <FileText className="h-6 w-6" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">
            {fileName}
          </span>
          <span className="block text-xs text-muted-foreground">
            Local-only attachment · Locate file to preview
          </span>
        </span>
      </button>
      {selection &&
        createPortal(
          <FileContentViewer
            isOpen
            onClose={() => setSelection(null)}
            file={selection.file}
            fileName={fileName}
            localPath={selection.path}
          />,
          document.body,
        )}
    </>
  );
}
