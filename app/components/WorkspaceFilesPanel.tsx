"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File,
  Folder,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  WORKSPACE_DOWNLOAD_LIMIT,
  WORKSPACE_PREVIEW_LIMIT,
  type WorkspaceEntry,
  type WorkspaceListing,
  type WorkspaceStatus,
} from "@/lib/sandbox/workspace-files";
import { AllFilesDialog } from "./AllFilesDialog";
import type { FilePart } from "@/types/file";
import { downloadFile } from "@/lib/utils/file-download";
import { isTauriEnvironment } from "../hooks/useTauri";

const errors: Record<string, string> = {
  rate_limited: "Too many file requests. Wait a minute, then refresh.",
  unauthorized: "Sign in again to access workspace files.",
  not_found:
    "This workspace or file is no longer available. Saved chat files are still separate below.",
  recovery_required:
    "This workspace needs recovery. Your existing workspace has been preserved.",
  workspace_changed:
    "The workspace changed. Close and reopen Files to reconnect.",
  subscription_required:
    "A paid plan is required to access the cloud workspace.",
  file_too_large:
    "This file exceeds the limit for this action. Preview supports 256 KB; download supports 2 MB.",
  directory_too_large:
    "This folder has more than 5,000 entries. Open a smaller folder using the Agent.",
  unreadable_path:
    "This path cannot be opened. Links and files outside the workspace are blocked.",
  unavailable: "Workspace Files is currently unavailable.",
};
const sizeLabel = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1048576
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1048576).toFixed(1)} MB`;
const textExtensions =
  /\.(txt|md|json|jsonl|csv|tsv|log|py|js|jsx|ts|tsx|sh|bash|zsh|yaml|yml|toml|ini|cfg|conf|xml|html|css|sql|rs|go|java|c|cpp|h|http|env)$/i;
const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function WorkspaceFilesPanel({
  messages,
  chatId,
}: {
  messages: any[];
  chatId: string;
}) {
  const [path, setPath] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [grid, setGrid] = useState(false);
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    name: string;
    text?: string;
    url?: string;
  } | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const sandboxId = useRef<string | undefined>(undefined);
  const fileRequest = useRef<AbortController | null>(null);
  const resume = useRef(false);
  const savedFiles = messages.flatMap((message) =>
    (message.fileDetails ?? []).map((file: any, index: number) => ({
      part: { ...file, filename: file.name, size: file.sizeBytes } as FilePart,
      partIndex: index,
      messageId: message.id,
    })),
  );

  const request = useCallback(
    async (
      action: string,
      values: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      const response = await fetch("/api/workspace-files", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          action,
          sandboxId: sandboxId.current,
          ...values,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          errors[data.error] ??
            "Workspace unavailable. Reconnect your environment and refresh.",
        );
      return data;
    },
    [chatId],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    setListing(null);
    fileRequest.current?.abort();
    setFileBusy(false);
    setPreview(null);
    const action = resume.current ? "resume" : "list";
    resume.current = false;
    request(action, { path, search: query, offset }, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        sandboxId.current = data.sandboxId ?? sandboxId.current;
        setStatus(data);
        setListing(data.entries ? data : null);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [request, path, query, offset, version]);

  useEffect(() => {
    captureAuthenticatedEvent("workspace_files_viewed");
    return () => fileRequest.current?.abort();
  }, []);
  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );

  const navigate = (next: string) => {
    setPath(next);
    setSearch("");
    setQuery("");
    setOffset(0);
  };
  const readFile = async (entry: WorkspaceEntry, download: boolean) => {
    fileRequest.current?.abort();
    const controller = new AbortController();
    fileRequest.current = controller;
    setFileBusy(true);
    setError(null);
    try {
      const filePath = path ? `${path}/${entry.name}` : entry.name;
      const data = await request(
        download ? "download" : "preview",
        { path: filePath },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!data.data && data.data !== "") {
        setStatus(data);
        setListing(null);
        return;
      }
      const bytes = Uint8Array.from(atob(data.data), (character) =>
        character.charCodeAt(0),
      );
      if (download) {
        if (isTauriEnvironment()) {
          // Existing native Save contract is UTF-8 text only. Do not corrupt binary bytes.
          let text: string;
          try {
            text = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes);
          } catch {
            throw new Error(
              "Binary downloads are available in the web app. Desktop can save UTF-8 text files here.",
            );
          }
          const saved = await downloadFile({
            filename: entry.name,
            content: text,
          });
          captureAuthenticatedEvent("workspace_file_download", {
            outcome: saved.outcome,
            surface: "desktop",
          });
        } else {
          const url = URL.createObjectURL(new Blob([bytes]));
          const link = document.createElement("a");
          link.href = url;
          link.download = entry.name;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30_000);
          captureAuthenticatedEvent("workspace_file_download", {
            outcome: "initiated",
            surface: "web",
          });
        }
      } else {
        const type =
          imageTypes[entry.name.split(".").pop()?.toLowerCase() ?? ""];
        if (type)
          setPreview({
            name: entry.name,
            url: URL.createObjectURL(new Blob([bytes], { type })),
          });
        else {
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new Error(
              "This binary file has no preview. Download it to open it.",
            );
          }
          if (text.includes("\0"))
            throw new Error(
              "This binary file has no preview. Download it to open it.",
            );
          setPreview({ name: entry.name, text });
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "Unable to read file.",
        );
    } finally {
      if (!controller.signal.aborted) setFileBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
      <div className="text-xs text-muted-foreground">
        Live cloud workspace · shared across your tasks. Download files you want
        to keep.
      </div>
      <div className="flex items-center gap-1 rounded-lg border p-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          aria-label="Parent folder"
          disabled={!path || busy}
          onClick={() => navigate(path.split("/").slice(0, -1).join("/"))}
        >
          <ArrowLeft size={16} />
        </Button>
        <nav
          aria-label="Workspace path"
          className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap text-xs"
        >
          <button
            className="rounded px-1 py-2 hover:bg-muted"
            onClick={() => navigate("")}
          >
            /home/user
          </button>
          {path
            .split("/")
            .filter(Boolean)
            .map((part, index, parts) => (
              <span className="flex items-center" key={index}>
                <ChevronRight size={12} />
                <button
                  className="max-w-40 truncate rounded px-1 py-2 hover:bg-muted"
                  onClick={() => navigate(parts.slice(0, index + 1).join("/"))}
                >
                  {part}
                </button>
              </span>
            ))}
        </nav>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          aria-label="Refresh workspace files"
          disabled={busy}
          onClick={() => setVersion((value) => value + 1)}
        >
          <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
        </Button>
      </div>
      <div className="flex gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            aria-label="Search this folder"
            placeholder="Search this folder"
            className="h-9 min-w-0 w-full bg-transparent text-sm outline-none"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <Button
          size="icon"
          variant="outline"
          aria-label="List view"
          aria-pressed={!grid}
          onClick={() => setGrid(false)}
        >
          <List size={16} />
        </Button>
        <Button
          size="icon"
          variant="outline"
          aria-label="Grid view"
          aria-pressed={grid}
          onClick={() => setGrid(true)}
        >
          <LayoutGrid size={16} />
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-xs"
        >
          {error}
        </div>
      )}
      <div
        className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/10 p-2"
        aria-busy={busy || fileBusy}
      >
        {busy ? (
          <p
            role="status"
            className="p-4 text-center text-sm text-muted-foreground"
          >
            Loading workspace…
          </p>
        ) : status?.state === "paused" ? (
          <div className="p-5 text-center text-sm">
            <p>Your workspace is paused.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Resume it to browse its live files.
            </p>
            <Button
              className="mt-3"
              onClick={() => {
                resume.current = true;
                setVersion((value) => value + 1);
              }}
            >
              Resume workspace
            </Button>
          </div>
        ) : status?.state === "missing" ? (
          <p className="p-5 text-sm text-muted-foreground">
            No live cloud workspace is available. It may have expired or been
            deleted. Start a cloud Agent task to create a workspace. Saved chat
            files remain available below.
          </p>
        ) : status?.state === "unsupported" ? (
          <p className="p-5 text-sm text-muted-foreground">
            This task uses Desktop or Remote Control. Browse its project folder
            on that computer. Live host browsing is not available here yet;
            saved chat files remain available below.
          </p>
        ) : (
          listing && (
            <>
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {listing.total} {query ? "matching " : ""}items
                {fileBusy ? " · Reading file…" : ""}
              </p>
              {!listing.entries.length && (
                <p className="p-5 text-center text-sm text-muted-foreground">
                  {query
                    ? "No matching files in this folder."
                    : "This folder is empty."}
                </p>
              )}
              <ul className={grid ? "grid grid-cols-2 gap-2" : "space-y-1"}>
                {listing.entries.map((entry) => {
                  const directory = entry.kind === "directory";
                  const previewable =
                    entry.kind === "file" &&
                    entry.size <= WORKSPACE_PREVIEW_LIMIT &&
                    (textExtensions.test(entry.name) ||
                      !!imageTypes[
                        entry.name.split(".").pop()?.toLowerCase() ?? ""
                      ] ||
                      !entry.name.includes("."));
                  return (
                    <li
                      key={entry.name}
                      className={`group flex min-w-0 gap-2 rounded-lg p-2 hover:bg-muted ${grid ? "flex-col border" : "items-center"}`}
                    >
                      <button
                        disabled={
                          busy || fileBusy || (!directory && !previewable)
                        }
                        onClick={() =>
                          directory
                            ? navigate(
                                path ? `${path}/${entry.name}` : entry.name,
                              )
                            : void readFile(entry, false)
                        }
                        className={`flex min-w-0 flex-1 gap-2 text-left disabled:cursor-default ${grid ? "flex-col" : "items-center"}`}
                        aria-label={`${directory ? "Open folder" : previewable ? "Preview" : "File"} ${entry.name}`}
                      >
                        {directory ? (
                          <Folder
                            className="shrink-0 text-muted-foreground"
                            size={grid ? 28 : 18}
                          />
                        ) : (
                          <File
                            className="shrink-0 text-muted-foreground"
                            size={grid ? 28 : 18}
                          />
                        )}
                        <span className="min-w-0">
                          <span
                            className="block truncate text-sm"
                            title={entry.name}
                          >
                            {entry.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {directory
                              ? "Folder"
                              : entry.kind === "symlink"
                                ? "Link · blocked"
                                : entry.kind === "file"
                                  ? sizeLabel(entry.size)
                                  : "Unsupported"}{" "}
                            · {new Date(entry.modified).toLocaleDateString()}
                          </span>
                        </span>
                      </button>
                      {entry.kind === "file" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 self-end"
                          aria-label={`Download ${entry.name}`}
                          title={
                            entry.size > WORKSPACE_DOWNLOAD_LIMIT
                              ? "Downloads support files up to 2 MB"
                              : "Download file"
                          }
                          disabled={
                            busy ||
                            fileBusy ||
                            entry.size > WORKSPACE_DOWNLOAD_LIMIT
                          }
                          onClick={() => void readFile(entry, true)}
                        >
                          <Download size={14} />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {(offset > 0 || listing.nextOffset !== null) && (
                <div className="mt-2 flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!offset}
                    onClick={() => setOffset(Math.max(0, offset - 100))}
                  >
                    Previous
                  </Button>
                  <span className="text-xs">Page {offset / 100 + 1}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={listing.nextOffset === null}
                    onClick={() => setOffset(listing.nextOffset!)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )
        )}
      </div>
      {preview && (
        <section
          aria-label={`Preview ${preview.name}`}
          className="flex max-h-[45%] min-h-0 flex-col overflow-hidden rounded-lg border"
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
            <span className="truncate text-sm">{preview.name}</span>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close file preview"
              onClick={() => setPreview(null)}
            >
              <X size={14} />
            </Button>
          </div>
          <div className="overflow-auto p-3">
            {preview.url ? (
              <Image
                unoptimized
                width={1200}
                height={800}
                src={preview.url}
                alt={preview.name}
                className="max-h-64 max-w-full object-contain"
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {preview.text}
              </pre>
            )}
          </div>
        </section>
      )}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Preview ≤256 KB · Download ≤2 MB</span>
        <Button variant="ghost" size="sm" onClick={() => setSavedOpen(true)}>
          Saved chat files ({savedFiles.length})
        </Button>
      </div>
      {savedOpen && (
        <AllFilesDialog
          open={savedOpen}
          onOpenChange={setSavedOpen}
          files={savedFiles}
        />
      )}
    </div>
  );
}
