"use client";

import type { CapturedFile } from "@/lib/workspace-preview/chat-files";
import { FileSourceDetails } from "./FileSourceDetails";
import { ChatFilesPanel } from "./ChatFilesPanel";
import { useGlobalState } from "../contexts/GlobalState";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File,
  Folder,
  FolderTree,
  LayoutGrid,
  List,
  MoreHorizontal,
  RefreshCw,
  Search,
} from "lucide-react";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { WorkspaceFileTree } from "./WorkspaceFileTree";
import WorkspaceFilePreview, {
  type WorkspacePreview,
} from "./WorkspaceFilePreview";
import {
  workspaceImageTypes as imageTypes,
  workspaceTextExtensions as textExtensions,
} from "@/lib/workspace-preview/format";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
    "This workspace or file is no longer available. Captured files are still available in This chat.",
  recovery_required:
    "This workspace needs recovery. Your existing workspace has been preserved.",
  workspace_changed:
    "The workspace changed. Close and reopen Files to reconnect.",
  subscription_required:
    "A paid plan is required to access the cloud workspace.",
  file_too_large:
    "This file exceeds the limit for this action. Preview supports 256 KB; download supports 50 MB.",
  directory_too_large:
    "This folder has more than 5,000 entries. Open a smaller folder using the Agent.",
  unreadable_path:
    "This path cannot be opened. Links and files outside the workspace are blocked.",
  unavailable: "Workspace Files is currently unavailable.",
  file_changed:
    "The file changed during download. Try again after it finishes writing.",
  local_reader_unavailable:
    "Local browsing requires Python 3 on this connected Mac or Linux environment.",
  select_environment:
    "Select a specific connected computer before browsing files.",
};
const sizeLabel = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1048576
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1048576).toFixed(1)} MB`;

export type LoadedWorkspaceFile = {
  id: string;
  file: WorkspacePreview;
  bytes: Uint8Array<ArrayBuffer>;
  source: string;
  loadedAt: number;
};

export function LiveWorkspaceFilesPanel({
  messages,
  chatId,
  environment,
  onOpenFile,
}: {
  messages: any[];
  chatId: string;
  environment?: string;
  onOpenFile?: (file: LoadedWorkspaceFile) => void;
}) {
  const [path, setPath] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [grid, setGrid] = useState(false);
  const [tree, setTree] = useState(true);
  const [treeSearch, setTreeSearch] = useState("");
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkspacePreview | null>(null);
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
          environment,
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
    [chatId, environment],
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
  const readFile = async (
    entry: WorkspaceEntry,
    download: boolean,
    selectedPath?: string,
  ) => {
    fileRequest.current?.abort();
    const controller = new AbortController();
    fileRequest.current = controller;
    setFileBusy(true);
    setError(null);
    try {
      const filePath =
        selectedPath ?? (path ? `${path}/${entry.name}` : entry.name);
      let data = await request(
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
      const chunks: Uint8Array[] = [];
      let total = 0;
      const expectedSize = data.size;
      const revision = data.revision;
      for (;;) {
        const chunk = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0));
        total += chunk.length;
        if (
          total > WORKSPACE_DOWNLOAD_LIMIT ||
          data.size !== expectedSize ||
          data.revision !== revision
        )
          throw new Error(errors.file_changed);
        chunks.push(chunk);
        if (!download || data.nextByteOffset == null) break;
        if (!chunk.length || data.nextByteOffset !== total)
          throw new Error(errors.file_changed);
        data = await request(
          "download",
          { path: filePath, byteOffset: total, revision },
          controller.signal,
        );
        if (controller.signal.aborted) return;
      }
      if (download && total !== expectedSize)
        throw new Error(errors.file_changed);
      const bytes = new Uint8Array(total);
      let position = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, position);
        position += chunk.length;
      }
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
        let nextPreview: WorkspacePreview;
        if (type)
          nextPreview = {
            name: entry.name,
            path: filePath,
            url: URL.createObjectURL(new Blob([bytes], { type })),
          };
        else {
          let text: string;
          try {
            text = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes);
          } catch {
            throw new Error(
              "This binary file has no preview. Download it to open it.",
            );
          }
          if (text.includes("\0"))
            throw new Error(
              "This binary file has no preview. Download it to open it.",
            );
          nextPreview = { name: entry.name, path: filePath, text };
        }
        if (onOpenFile) {
          onOpenFile({
            id: JSON.stringify([
              environment,
              sandboxId.current,
              filePath,
              revision,
            ]),
            file: nextPreview,
            bytes,
            source:
              status?.environmentLabel ??
              (environment === "e2b" || environment === "cloud"
                ? "Cloud"
                : "Local / Desktop"),
            loadedAt: Date.now(),
          });
        } else setPreview(nextPreview);
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
      <FileSourceDetails
        label={`${status?.environmentLabel ?? (environment === "cloud" || environment === "e2b" ? "Cloud" : "Local / Desktop")}${status?.root ? ` · ${status.root}` : ""}`}
        name="Workspace details"
      >
        <p>
          Live files can change and may be shared across tasks. Download files
          you want to keep.
        </p>
      </FileSourceDetails>
      {!tree && (
        <div className="flex items-center gap-1 rounded-lg border p-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0 max-sm:h-11 max-sm:w-11"
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
              {status?.root ?? "Workspace"}
            </button>
            {path
              .split("/")
              .filter(Boolean)
              .map((part, index, parts) => (
                <span className="flex items-center" key={index}>
                  <ChevronRight size={12} />
                  <button
                    className="max-w-40 truncate rounded px-1 py-2 hover:bg-muted"
                    onClick={() =>
                      navigate(parts.slice(0, index + 1).join("/"))
                    }
                  >
                    {part}
                  </button>
                </span>
              ))}
          </nav>
          <Button
            size="icon"
            variant="ghost"
            className="hidden h-8 w-8 shrink-0 sm:inline-flex"
            aria-label="Refresh workspace files"
            disabled={busy}
            onClick={() => setVersion((value) => value + 1)}
          >
            <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            aria-label={tree ? "Search expanded folders" : "Search this folder"}
            placeholder={
              tree ? "Search expanded folders" : "Search this folder"
            }
            className="h-11 min-w-0 w-full bg-transparent text-base outline-none sm:h-9 sm:text-sm"
            value={tree ? treeSearch : search}
            onChange={(event) =>
              tree
                ? setTreeSearch(event.target.value)
                : setSearch(event.target.value)
            }
          />
        </label>
        <div className="hidden gap-2 sm:flex">
          {tree && (
            <Button
              size="icon"
              variant="outline"
              aria-label="Refresh workspace files"
              disabled={busy}
              onClick={() => setVersion((value) => value + 1)}
            >
              <RefreshCw size={16} />
            </Button>
          )}
          <Button
            size="icon"
            variant="outline"
            aria-label="Tree view"
            aria-pressed={tree}
            onClick={() => {
              navigate("");
              setTree(true);
            }}
          >
            <FolderTree size={16} />
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label="List view"
            aria-pressed={!tree && !grid}
            onClick={() => {
              setTree(false);
              setGrid(false);
            }}
          >
            <List size={16} />
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label="Grid view"
            aria-pressed={!tree && grid}
            onClick={() => {
              setTree(false);
              setGrid(true);
            }}
          >
            <LayoutGrid size={16} />
          </Button>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0 sm:hidden"
              aria-label="File options"
            >
              <MoreHorizontal size={20} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-52"
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <DropdownMenuItem
              className="min-h-11"
              disabled={busy}
              onSelect={() => setVersion((value) => value + 1)}
            >
              <RefreshCw size={16} /> Refresh files
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>View</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={tree ? "tree" : grid ? "grid" : "list"}
              onValueChange={(view) => {
                if (view === "tree") navigate("");
                setTree(view === "tree");
                setGrid(view === "grid");
              }}
            >
              <DropdownMenuRadioItem className="min-h-11" value="tree">
                Folder tree
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem className="min-h-11" value="list">
                List
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem className="min-h-11" value="grid">
                Grid
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {savedFiles.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="min-h-11"
                  onSelect={() => setSavedOpen(true)}
                >
                  Saved chat files ({savedFiles.length})
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
        className={`min-h-0 overflow-auto rounded-lg border bg-muted/10 p-2 ${preview ? "max-h-[40%] flex-1" : "flex-1"}`}
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
        ) : status?.state === "disconnected" ? (
          <p className="p-5 text-sm text-muted-foreground">
            This computer is disconnected. Reconnect it to browse live files.
            Captured files remain available in This chat.
          </p>
        ) : status?.state === "unsupported" ? (
          <p className="p-5 text-sm text-muted-foreground">
            Live browsing is currently supported on Cloud, macOS and Linux with
            Python 3. This connection needs a supported file reader. Captured
            chat files remain available in This chat.
          </p>
        ) : (
          listing &&
          (tree ? (
            <WorkspaceFileTree
              rootLabel={status?.root ?? "Workspace"}
              key={version}
              initial={listing}
              filter={treeSearch}
              busy={fileBusy}
              selected={preview?.path}
              load={async (folderPath, pageOffset, signal) => {
                const data = await request(
                  "list",
                  { path: folderPath, offset: pageOffset },
                  signal,
                );
                if (signal.aborted) return null;
                if (!data.entries) {
                  setStatus(data);
                  setListing(null);
                  setPreview(null);
                  fileRequest.current?.abort();
                  setFileBusy(false);
                  return null;
                }
                return data;
              }}
              onFile={(entry, filePath, download) =>
                void readFile(entry, download, filePath)
              }
            />
          ) : (
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
                        className={`flex min-w-0 flex-1 gap-2 text-left max-sm:min-h-11 disabled:cursor-default ${grid ? "flex-col" : "items-center"}`}
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
                          {entry.kind === "file" &&
                            entry.size > WORKSPACE_PREVIEW_LIMIT && (
                              <span className="block text-xs text-muted-foreground">
                                {entry.size > WORKSPACE_DOWNLOAD_LIMIT
                                  ? "Exceeds 50 MB download limit"
                                  : "Too large to preview · Download available"}
                              </span>
                            )}
                        </span>
                      </button>
                      {entry.kind === "file" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 self-end max-sm:h-11 max-sm:w-11"
                          aria-label={`Download ${entry.name}`}
                          title={
                            entry.size > WORKSPACE_DOWNLOAD_LIMIT
                              ? "Downloads support files up to 50 MB"
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
          ))
        )}
      </div>
      {preview && (
        <WorkspaceFilePreview
          key={preview.path}
          file={preview}
          busy={fileBusy}
          onClose={() => setPreview(null)}
          onDownload={() =>
            void readFile(
              { name: preview.name, kind: "file", size: 0, modified: 0 },
              true,
              preview.path,
            )
          }
        />
      )}
      {savedFiles.length > 0 && (
        <div className="hidden items-center justify-end gap-2 text-xs text-muted-foreground sm:flex">
          <Button variant="ghost" size="sm" onClick={() => setSavedOpen(true)}>
            Saved chat files ({savedFiles.length})
          </Button>
        </div>
      )}
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

export function WorkspaceFilesPanel({
  messages,
  chatId,
  onOpenCapturedFile,
  onOpenWorkspaceFile,
}: {
  messages: any[];
  chatId: string;
  onOpenCapturedFile?: (file: CapturedFile) => void;
  onOpenWorkspaceFile?: (file: LoadedWorkspaceFile) => void;
}) {
  const { sandboxPreference } = useGlobalState();
  const [tab, setTab] = useState<"chat" | "workspace">("chat");
  useEffect(() => {
    captureAuthenticatedEvent("workspace_files_viewed", { source: "chat" });
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col sm:pt-3">
      <div
        role="group"
        className="flex gap-2 max-sm:[&>button]:min-h-11 max-sm:[&>button]:flex-1"
        aria-label="File sources"
      >
        <Button
          variant={tab === "chat" ? "secondary" : "ghost"}
          aria-pressed={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          This chat
        </Button>
        <Button
          variant={tab === "workspace" ? "secondary" : "ghost"}
          aria-pressed={tab === "workspace"}
          onClick={() => setTab("workspace")}
        >
          Workspace
        </Button>
      </div>
      {tab === "chat" ? (
        <ChatFilesPanel messages={messages} onOpenFile={onOpenCapturedFile} />
      ) : (
        <LiveWorkspaceFilesPanel
          key={`${chatId}:${sandboxPreference}`}
          chatId={chatId}
          messages={messages}
          environment={sandboxPreference}
          onOpenFile={onOpenWorkspaceFile}
        />
      )}
    </div>
  );
}
