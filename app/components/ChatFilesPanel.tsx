"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { File, Folder } from "lucide-react";
import { FileSourceDetails } from "./FileSourceDetails";
import { Button } from "@/components/ui/button";
import {
  collectChatFiles,
  type CapturedFile,
  type FileMessage,
} from "@/lib/workspace-preview/chat-files";
import WorkspaceFilePreview, {
  type WorkspacePreview,
} from "./WorkspaceFilePreview";
import {
  workspaceImageTypes,
  workspaceTextExtensions,
} from "@/lib/workspace-preview/format";
import {
  WORKSPACE_PREVIEW_LIMIT,
  WORKSPACE_DOWNLOAD_LIMIT,
} from "@/lib/sandbox/workspace-files";
import {
  downloadFile,
  type DownloadFileResult,
} from "@/lib/utils/file-download";
import {
  elapsedMs,
  telemetryNow,
  trackWorkspaceFiles,
} from "@/lib/analytics/workspace-files";
const DiffView = dynamic(() => import("./DiffView").then((m) => m.DiffView), {
  ssr: false,
});

// Cancelling the body aborts a rejected transfer. Cleanup failures must not
// replace the error the user sees.
function discard(stream: { cancel(): Promise<void> } | null | undefined) {
  void Promise.resolve()
    .then(() => stream?.cancel())
    .catch(() => {});
}

async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || !response.body) {
    discard(response.body);
    throw new Error("Saved file is unavailable.");
  }
  if (Number(response.headers.get("content-length")) > limit) {
    discard(response.body);
    throw new Error("File exceeds the size limit for this action.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Error("File exceeds the size limit for this action.");
      chunks.push(value);
    }
  } finally {
    discard(reader);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

type PreviewSettled = {
  fileId: string;
  outcome: "success" | "failed" | "unavailable";
  durationMs?: number;
};

/**
 * `visible` opts into Files preview telemetry; callers outside the Computer
 * Files tabs (Activity, standalone panels) omit it and report no previews.
 * `compact` callers provide their own back navigation, so close actions hide.
 */
export function CapturedFilePreview({
  file,
  onClose,
  visible,
  compact = false,
}: {
  file: CapturedFile;
  onClose: () => void;
  visible?: boolean;
  compact?: boolean;
}) {
  const getUrl = useAction(api.s3Actions.getFileUrlAction);
  const [preview, setPreview] = useState<WorkspacePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState(false);
  const [settled, setSettled] = useState<PreviewSettled | null>(null);
  const reportedPreview = useRef<string | null>(null);
  const filename = file.saved?.filename ?? file.name;
  const fileKind =
    file.text !== undefined || !file.saved
      ? "captured_result"
      : "saved_attachment";
  const fileId = file.id;
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setPreview(null);
    setError("");
    setChanges(false);
    setSettled(null);
    if (file.text !== undefined) {
      setPreview({ name: filename, path: file.path, text: file.text });
      // Captured text renders without a load, so there is no latency to report.
      setSettled({ fileId, outcome: "success" });
      return () => controller.abort();
    }
    const started = telemetryNow();
    const settle = (outcome: PreviewSettled["outcome"]) =>
      setSettled({ fileId, outcome, durationMs: elapsedMs(started) });
    async function load() {
      if (!file.saved?.fileId) {
        setError(
          "This older file has no saved-file reference. It cannot be recovered from the current workspace.",
        );
        settle("unavailable");
        return;
      }
      const imageType =
        workspaceImageTypes[filename.split(".").pop()?.toLowerCase() ?? ""];
      if (
        !imageType &&
        !workspaceTextExtensions.test(filename) &&
        filename.includes(".")
      ) {
        setError(
          "Preview is unavailable for this format. Download the saved file to inspect it.",
        );
        return;
      }
      // Missing stored files are unavailable; undecodable bytes are an
      // unsupported format. Neither is a failed read.
      let failure: PreviewSettled["outcome"] | null = "failed";
      try {
        const url = await getUrl({ fileId: file.saved.fileId });
        if (!url) {
          failure = "unavailable";
          throw new Error("Saved file is unavailable.");
        }
        const bytes = await readBounded(
          await fetch(url, { signal: controller.signal }),
          WORKSPACE_PREVIEW_LIMIT,
        );
        if (controller.signal.aborted) return;
        if (imageType) {
          objectUrl = URL.createObjectURL(
            new Blob([bytes], { type: imageType }),
          );
          setPreview({ name: filename, path: file.path, url: objectUrl });
        } else {
          failure = null;
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          setPreview({ name: filename, path: file.path, text });
        }
        settle("success");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : "Preview unavailable.",
          );
          if (failure) settle(failure);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.saved?.fileId, file.text, file.path, filename, getUrl, fileId]);
  // Report once per file after it settles and while its tab is visible.
  useEffect(() => {
    if (
      !visible ||
      !settled ||
      settled.fileId !== fileId ||
      reportedPreview.current === fileId
    )
      return;
    const accepted = trackWorkspaceFiles("workspace_file_preview", {
      outcome: settled.outcome,
      file_kind: fileKind,
      entry_point: "computer_files",
      duration_ms: settled.durationMs,
    });
    if (accepted) reportedPreview.current = fileId;
  }, [visible, settled, fileId, fileKind]);
  const download = async () => {
    setBusy(true);
    setError("");
    const started = telemetryNow();
    let result: DownloadFileResult;
    let failure: string | undefined;
    try {
      if (file.text !== undefined)
        result = await downloadFile({
          filename: file.partial ? `${filename}.excerpt.txt` : filename,
          content: file.text,
        });
      else if (file.saved?.fileId) {
        const fileId = file.saved.fileId;
        result = await downloadFile({
          filename,
          // Loaded after the browser picker opens, which needs the click's activation.
          // Signed URLs expire; resolve a fresh one from the stored file on every attempt.
          content: async () => {
            const url = await getUrl({ fileId });
            if (!url) throw new Error("Saved file is unavailable.");
            return readBounded(await fetch(url), WORKSPACE_DOWNLOAD_LIMIT);
          },
          mimeType: file.saved.mediaType || "application/octet-stream",
        });
      } else throw new Error("This file has no saved download.");
    } catch (cause) {
      result = { outcome: "failed" };
      // Network failures surface as TypeError("Failed to fetch"); give a next step instead.
      failure =
        cause instanceof Error && !(cause instanceof TypeError) && cause.message
          ? cause.message
          : "The saved file could not be loaded. Check your connection and try again.";
    }
    setBusy(false);
    trackWorkspaceFiles("workspace_file_download", {
      outcome: result.outcome,
      source: "chat",
      file_kind: fileKind,
      // Activity and standalone viewers share this preview; keep their
      // downloads, but separate them from the Computer Files tabs.
      entry_point: visible === undefined ? "other" : "computer_files",
      reason: result.reason,
      duration_ms: elapsedMs(started),
    });
    // Cancel is a no-op. Failures keep an inline reason beside the retry action.
    if (result.outcome === "failed")
      setError(
        failure ??
          (result.reason === "unsupported_native"
            ? "Update HackerAI Desktop to save this file, then try again."
            : "The file could not be saved. Try again."),
      );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <FileSourceDetails
        label={`${file.source} · Captured`}
        name="Captured file details"
      >
        <p>
          {file.action} · {file.detail}
          {file.capturedAt
            ? ` · ${new Date(file.capturedAt).toLocaleString()}`
            : ""}
        </p>
        <p>
          Saved with this tool result. Changing environments does not change
          this view.
        </p>
      </FileSourceDetails>
      {file.partial && (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          Captured excerpt · This is not the complete file.
        </p>
      )}
      {file.originalText !== undefined && (
        <Button
          variant="outline"
          size="sm"
          aria-pressed={changes}
          onClick={() => setChanges(!changes)}
        >
          {changes ? "Show captured file" : "Show changes"}
        </Button>
      )}
      {error && (
        <p role="status" className="p-2 text-sm">
          {error}
        </p>
      )}
      {changes && file.originalText !== undefined ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <DiffView
            originalContent={file.originalText}
            modifiedContent={file.text ?? ""}
            language="text"
            wrap
          />
        </div>
      ) : preview ? (
        <WorkspaceFilePreview
          file={preview}
          onClose={onClose}
          busy={busy}
          compact={compact}
          onDownload={() => void download()}
          partial={file.partial}
        />
      ) : (
        <div className="flex gap-2">
          <Button
            className={compact ? "h-11" : undefined}
            disabled={busy || !file.saved?.fileId}
            onClick={() => void download()}
          >
            Download saved file
          </Button>
          {!compact && (
            <Button variant="ghost" onClick={onClose}>
              Back to files
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type TreeNode = { folders: Map<string, TreeNode>; files: CapturedFile[] };
function FileTree({
  node,
  onOpen,
}: {
  node: TreeNode;
  onOpen: (file: CapturedFile) => void;
}) {
  return (
    <ul className="space-y-1 pl-3">
      {[...node.folders].map(([name, child]) => (
        <li key={name}>
          <details open>
            <summary className="cursor-pointer py-1 text-sm">
              <Folder size={14} className="mr-2 inline" />
              {name}
            </summary>
            <FileTree node={child} onOpen={onOpen} />
          </details>
        </li>
      ))}
      {node.files.map((file) => (
        <li key={file.id}>
          <button
            onClick={() => onOpen(file)}
            className="flex w-full items-start gap-2 rounded p-2 max-sm:min-h-11 text-left hover:bg-muted focus-visible:ring-2"
            title={file.path}
          >
            <File size={15} className="mt-1 shrink-0" />
            <span className="min-w-0">
              <span className="block break-all text-sm">{file.name}</span>
              <span className="block text-xs text-muted-foreground">
                {file.action} · {file.detail}
                {file.capturedAt
                  ? ` · ${new Date(file.capturedAt).toLocaleTimeString()}`
                  : ""}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ChatFilesPanel({
  messages,
  onOpenFile,
  loading = false,
}: {
  messages: FileMessage[];
  onOpenFile?: (file: CapturedFile) => void;
  loading?: boolean;
}) {
  const files = useMemo(() => collectChatFiles(messages), [messages]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = files.find((file) => file.id === selectedId);
  const root = useMemo(() => {
    const root: TreeNode = { folders: new Map(), files: [] };
    for (const file of [...files].reverse()) {
      if (
        !`${file.path} ${file.source} ${file.action}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        continue;
      let node = root;
      const directories = [
        file.source,
        ...file.path.split(/[\\/]/).filter(Boolean).slice(0, -1),
      ];
      for (const directory of directories) {
        if (!node.folders.has(directory))
          node.folders.set(directory, { folders: new Map(), files: [] });
        node = node.folders.get(directory)!;
      }
      node.files.push(file);
    }
    return root;
  }, [files, query]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 py-3">
      {selected ? (
        <CapturedFilePreview
          key={selected.id}
          file={selected}
          onClose={() => setSelectedId(null)}
        />
      ) : (
        <>
          <FileSourceDetails label="Captured files" name="Chat files details">
            <p>
              File versions and saved outputs from this chat. Available
              independently of the current environment.
            </p>
          </FileSourceDetails>
          <input
            aria-label="Search chat files"
            placeholder="Search chat files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="rounded border bg-background p-2 text-sm max-sm:min-h-11 max-sm:text-base"
          />
          <nav
            aria-label="Files in this chat"
            className="min-h-0 flex-1 overflow-auto"
          >
            <FileTree
              node={root}
              onOpen={(file) =>
                onOpenFile ? onOpenFile(file) : setSelectedId(file.id)
              }
            />
          </nav>
          {loading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading saved files…
            </p>
          )}
          {!files.length && !loading && (
            <p className="text-sm text-muted-foreground">
              No captured file contents yet. Files appear after the Agent reads,
              writes, edits, or delivers them. Use Workspace to browse other
              current files.
            </p>
          )}
          {!!files.length && !root.folders.size && (
            <p className="text-sm">No matching files.</p>
          )}
        </>
      )}
    </div>
  );
}
