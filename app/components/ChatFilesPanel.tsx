"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { File, Folder } from "lucide-react";
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
import { downloadFile } from "@/lib/utils/file-download";
import { isTauriEnvironment } from "../hooks/useTauri";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
const DiffView = dynamic(() => import("./DiffView").then((m) => m.DiffView), {
  ssr: false,
});

async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok || !response.body)
    throw new Error("Saved file is unavailable.");
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error("File exceeds the size limit for this action.");
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
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function CapturedFilePreview({
  file,
  onClose,
}: {
  file: CapturedFile;
  onClose: () => void;
}) {
  const getUrl = useAction(api.s3Actions.getFileUrlAction);
  const [preview, setPreview] = useState<WorkspacePreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState(false);
  const filename = file.saved?.filename ?? file.name;
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setPreview(null);
    setError("");
    setChanges(false);
    if (file.text !== undefined) {
      setPreview({ name: filename, path: file.path, text: file.text });
      return () => controller.abort();
    }
    async function load() {
      if (!file.saved?.fileId) {
        setError(
          "This older file has no saved-file reference. It cannot be recovered from the current workspace.",
        );
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
      try {
        const url = await getUrl({ fileId: file.saved.fileId });
        if (!url) throw new Error("Saved file is unavailable.");
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
        } else
          setPreview({
            name: filename,
            path: file.path,
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Preview unavailable.",
          );
      }
    }
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.saved?.fileId, file.text, file.path, filename, getUrl]);
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const downloadName = file.partial ? `${filename}.excerpt.txt` : filename;
      if (file.text !== undefined)
        await downloadFile({ filename: downloadName, content: file.text });
      else if (file.saved?.fileId) {
        const url = await getUrl({ fileId: file.saved.fileId });
        if (!url) throw new Error("Saved file is unavailable.");
        const bytes = await readBounded(
          await fetch(url),
          WORKSPACE_DOWNLOAD_LIMIT,
        );
        if (isTauriEnvironment()) {
          let content: string;
          try {
            content = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes);
          } catch {
            throw new Error(
              "Use the web app to download binary files. Desktop can save UTF-8 text here.",
            );
          }
          await downloadFile({ filename, content });
        } else {
          const blobUrl = URL.createObjectURL(new Blob([bytes]));
          const link = document.createElement("a");
          link.href = blobUrl;
          link.download = filename;
          link.click();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
        }
      } else throw new Error("This file has no saved download.");
      captureAuthenticatedEvent("workspace_file_download", {
        source: "chat",
        outcome: "initiated",
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Download unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="px-2 text-xs text-muted-foreground">
        {file.source} · {file.action} · {file.detail}
        {file.capturedAt
          ? ` · ${new Date(file.capturedAt).toLocaleString()}`
          : ""}
      </p>
      <p className="px-2 text-xs text-muted-foreground">
        Saved with this tool result. Changing environments does not change this
        view.{file.partial ? " This is an excerpt, not the complete file." : ""}
      </p>
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
          onDownload={() => void download()}
          partial={file.partial}
        />
      ) : (
        <div className="flex gap-2">
          <Button
            disabled={busy || !file.saved?.fileId}
            onClick={() => void download()}
          >
            Download saved file
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Back to files
          </Button>
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
            className="flex w-full items-start gap-2 rounded p-2 text-left hover:bg-muted focus-visible:ring-2"
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

export function ChatFilesPanel({ messages }: { messages: FileMessage[] }) {
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
          <p className="text-xs text-muted-foreground">
            Captured file versions and saved outputs from this chat. Available
            independently of the current environment.
          </p>
          <input
            aria-label="Search chat files"
            placeholder="Search chat files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="rounded border bg-background p-2 text-sm"
          />
          <nav
            aria-label="Files in this chat"
            className="min-h-0 flex-1 overflow-auto"
          >
            <FileTree node={root} onOpen={(file) => setSelectedId(file.id)} />
          </nav>
          {!files.length && (
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
