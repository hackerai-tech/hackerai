"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Files,
  FolderOpen,
  Maximize2,
  Minimize2,
  Monitor,
  PanelRight,
  X,
} from "lucide-react";
import {
  isSidebarFile,
  isSidebarWorkspaceFiles,
  type SidebarContent,
} from "@/types/chat";
import {
  collectChatFiles,
  type CapturedFile,
  type FileMessage,
} from "@/lib/workspace-preview/chat-files";
import { extractSidebarContentFromMessage } from "@/lib/utils/sidebar-utils";
import { useSavedChatFiles } from "../hooks/useSavedChatFiles";
import { FileSourceDetails } from "./FileSourceDetails";
import { CapturedFilePreview } from "./ChatFilesPanel";
import {
  WorkspaceFilesPanel,
  type LoadedWorkspaceFile,
} from "./WorkspaceFilesPanel";
import WorkspaceFilePreview from "./WorkspaceFilePreview";
import {
  elapsedMs,
  telemetryNow,
  trackWorkspaceFiles,
} from "@/lib/analytics/workspace-files";
import { downloadFile } from "@/lib/utils/file-download";
import { isTauriEnvironment } from "../hooks/useTauri";
import { useComputerSidebarOverlay } from "@/hooks/use-workspace-layout";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Below Tailwind `sm`, previews replace the tab strip with back navigation.
const PHONE_QUERY = "(width < 40rem)";
const shortTime = (time: number) =>
  new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

type FileTab = { id: string; name: string } & (
  | { kind: "captured"; capturedId: string }
  | { kind: "workspace"; loaded: LoadedWorkspaceFile }
);

/** Tabs belong to one chat. Captured contents always resolve from its current messages. */
export function ComputerWorkspace({
  chatId,
  messages,
  open,
  selection,
  openRequest,
  onClose,
  renderActivity,
}: {
  chatId: string;
  messages: FileMessage[];
  open: boolean;
  selection: SidebarContent | null;
  openRequest: number;
  onClose: () => void;
  renderActivity: (
    content: SidebarContent | null,
    visible: boolean,
  ) => ReactNode;
}) {
  const prefix = useId();
  const [active, setActive] = useState("activity");
  const [filesVisited, setFilesVisited] = useState(false);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activity, setActivity] = useState<SidebarContent | null>(null);
  const [expanded, setExpanded] = useState(false);
  const overlay = useComputerSidebarOverlay();
  const phone = useMediaQuery(PHONE_QUERY);
  const fullscreen = expanded && !overlay;
  const frame = useRef<HTMLDivElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });
  const expandButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const previewPicked = useRef(false);
  const [lastRequest, setLastRequest] = useState<number | null>(null);
  const [previousSelection, setPreviousSelection] = useState(selection);
  const ownedUrls = useRef(new Map<string, string>());
  // Saved files from pages outside the loaded history; Activity keeps using `messages`.
  const saved = useSavedChatFiles({
    chatId,
    messages,
    enabled: open && filesVisited,
  });
  const fileMessages = saved.messages;
  const captures = useMemo(
    () => collectChatFiles(fileMessages),
    [fileMessages],
  );
  const activityContent = useMemo(() => {
    if (activity) return activity;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const content = extractSidebarContentFromMessage(messages[index]);
      if (content.length) return content.at(-1) ?? null;
    }
    return null;
  }, [activity, messages]);

  const openFiles = useCallback(() => {
    setFilesVisited(true);
    setActive("files");
  }, []);
  const openCaptured = useCallback((file: CapturedFile) => {
    const id = `captured:${file.id}`;
    setTabs((current) =>
      current.some((tab) => tab.id === id)
        ? current
        : [
            ...current,
            { id, name: file.name, kind: "captured", capturedId: file.id },
          ],
    );
    setActive(id);
  }, []);
  const openWorkspace = (loaded: LoadedWorkspaceFile) => {
    const id = `workspace:${loaded.id}`;
    // The panel transfers ownership of image URLs. Reopening the same revision reuses its tab.
    if (tabs.some((tab) => tab.id === id)) {
      if (loaded.file.url) URL.revokeObjectURL(loaded.file.url);
    } else {
      if (loaded.file.url) ownedUrls.current.set(id, loaded.file.url);
      setTabs((current) => [
        ...current,
        { id, name: loaded.file.name, kind: "workspace", loaded },
      ]);
    }
    setActive(id);
  };
  useEffect(
    () => () => {
      for (const url of ownedUrls.current.values()) URL.revokeObjectURL(url);
      ownedUrls.current.clear();
    },
    [],
  );

  // Background mounts keep tabs alive while hidden; count only what users see.
  // Refs survive effect replay, so each chat reports once per mounted workspace.
  const exposedChat = useRef<string | null>(null);
  const viewedChat = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    if (
      exposedChat.current !== chatId &&
      trackWorkspaceFiles("workspace_files_exposed", {})
    ) {
      exposedChat.current = chatId;
    }
    if (
      active === "files" &&
      viewedChat.current !== chatId &&
      trackWorkspaceFiles("workspace_files_viewed", {})
    ) {
      viewedChat.current = chatId;
    }
  }, [open, active, chatId]);

  // Reconcile explicit open requests before rendering the selected panel. Streaming
  // updates and Activity timeline navigation retain the user's selected tab.
  if (selection !== previousSelection) {
    setPreviousSelection(selection);
    if (selection && !isSidebarWorkspaceFiles(selection))
      setActivity(selection);
    else if (!selection && open) setActivity(null);
  }
  if (open && selection && lastRequest !== openRequest) {
    setLastRequest(openRequest);
    if (isSidebarWorkspaceFiles(selection)) openFiles();
    else {
      setActivity(selection);
      const capture =
        isSidebarFile(selection) &&
        selection.action !== "viewing" &&
        !selection.isExecuting &&
        !selection.error &&
        captures.find((file) => file.toolCallId === selection.toolCallId);
      if (capture) openCaptured(capture);
      else setActive("activity");
    }
  }

  const activeFile = tabs.find((tab) => tab.id === active);
  // Phone previews show one file with back navigation instead of the tab strip.
  const phonePreview = phone && !!activeFile;

  useEffect(() => {
    if (!open) return;
    if (phonePreview) {
      backButton.current?.focus({ preventScroll: true });
      return;
    }
    const tab = document.getElementById(`${prefix}-tab-${active}`);
    tab?.parentElement?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
    tab?.focus({ preventScroll: true });
  }, [active, open, prefix, overlay, phonePreview]);

  useEffect(() => {
    if (!open || !fullscreen) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    expandButton.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [open, fullscreen]);

  useEffect(() => {
    const strip = tabStrip.current;
    if (!open || phone || !strip) return;
    const update = () => {
      const left = strip.scrollLeft > 1;
      const right =
        strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
      setTabScroll((current) =>
        current.left === left && current.right === right
          ? current
          : { left, right },
      );
    };
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            // Overflow controls change the viewport width after the tab opens.
            // Reveal the entire tab, including its close button, after resizing.
            document
              .getElementById(`${prefix}-tab-${active}`)
              ?.parentElement?.scrollIntoView?.({
                block: "nearest",
                inline: "nearest",
              });
            update();
          });
    observer?.observe(strip);
    strip.addEventListener("scroll", update, { passive: true });
    return () => {
      observer?.disconnect();
      strip.removeEventListener("scroll", update);
    };
  }, [open, tabs.length, active, prefix, phone]);

  const scrollTabs = (direction: number) => {
    const strip = tabStrip.current;
    strip?.scrollBy({
      left: direction * Math.max(120, strip.clientWidth * 0.75),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };

  const visibleTabs = [
    { id: "activity", name: "Activity", icon: Monitor, closable: false },
    { id: "files", name: "Files", icon: FolderOpen, closable: false },
    ...tabs.map((tab) => ({ ...tab, icon: FileText, closable: true })),
  ];
  // Phones keep open previews in a menu on Files rather than in the strip.
  const stripTabs = phone ? visibleTabs.slice(0, 2) : visibleTabs;
  const tabTitle = (tab: FileTab) => {
    if (tab.kind === "workspace")
      return `${tab.loaded.file.path} · ${tab.loaded.source}`;
    const capture = captures.find((file) => file.id === tab.capturedId);
    return capture
      ? `${capture.path} · Captured from ${capture.source}`
      : tab.name;
  };
  const tabDetail = (tab: FileTab) => {
    if (tab.kind === "workspace")
      return `${tab.loaded.source} · Snapshot ${shortTime(tab.loaded.loadedAt)}`;
    const capture = captures.find((file) => file.id === tab.capturedId);
    if (!capture) return "Captured";
    return `${capture.source} · Captured${capture.capturedAt ? ` ${shortTime(capture.capturedAt)}` : ""}`;
  };
  const focusTab = (id: string) => {
    if (id === "files") setFilesVisited(true);
    setActive(id);
    requestAnimationFrame(() =>
      document.getElementById(`${prefix}-tab-${id}`)?.focus(),
    );
  };
  const closeTab = (id: string) => {
    const index = visibleTabs.findIndex((tab) => tab.id === id);
    if (id === "activity" || id === "files") return;
    const url = ownedUrls.current.get(id);
    if (url) URL.revokeObjectURL(url);
    ownedUrls.current.delete(id);
    setTabs((current) => current.filter((tab) => tab.id !== id));
    focusTab(active === id ? visibleTabs[Math.max(0, index - 1)].id : active);
  };

  return (
    <div
      ref={frame}
      hidden={!open}
      className={
        fullscreen ? "fixed inset-0 z-50 bg-background p-4" : "h-full w-full"
      }
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen ? true : undefined}
      aria-label={fullscreen ? "Computer workspace" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (fullscreen) setExpanded(false);
          else onClose();
        }
        if (fullscreen && event.key === "Tab") {
          const elements = Array.from(
            frame.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), a[href], input, select, textarea, [tabindex="0"]',
            ) ?? [],
          ).filter(
            (element) =>
              element.tabIndex >= 0 && element.getClientRects().length > 0,
          );
          const first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] border border-border/40 bg-background max-sm:rounded-none max-sm:border-0">
        <div className="flex min-w-0 items-center gap-1 border-b bg-muted/20 px-2 pt-2">
          {phonePreview && activeFile ? (
            <>
              <button
                ref={backButton}
                aria-label="Back to Files"
                onClick={() => focusTab("files")}
                className="mb-1 flex min-h-11 shrink-0 items-center gap-1 rounded-md pl-1 pr-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft size={20} aria-hidden />
                Files
              </button>
              <h2
                id={`${prefix}-title`}
                title={tabTitle(activeFile)}
                className="mb-1 min-w-0 flex-1 truncate px-1 text-sm font-medium"
              >
                {activeFile.name}
              </h2>
            </>
          ) : (
            <div
              ref={tabStrip}
              role="tablist"
              aria-label="Computer tabs"
              className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
            >
              {stripTabs.map((tab, index) => (
                <div
                  key={tab.id}
                  className={`flex max-w-[min(12rem,100%)] shrink-0 items-center rounded-t-lg border border-b-0 ${active === tab.id ? "border-border bg-background" : "border-transparent text-muted-foreground hover:bg-muted/60"}`}
                >
                  <button
                    role="tab"
                    id={`${prefix}-tab-${tab.id}`}
                    aria-controls={`${prefix}-panel-${tab.id}`}
                    aria-selected={active === tab.id}
                    tabIndex={active === tab.id ? 0 : -1}
                    title={"kind" in tab ? tabTitle(tab) : tab.name}
                    onClick={() => focusTab(tab.id)}
                    className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onKeyDown={(event) => {
                      let next: number | undefined;
                      if (event.key === "ArrowRight")
                        next = (index + 1) % stripTabs.length;
                      if (event.key === "ArrowLeft")
                        next =
                          (index - 1 + stripTabs.length) % stripTabs.length;
                      if (event.key === "Home") next = 0;
                      if (event.key === "End") next = stripTabs.length - 1;
                      if (next !== undefined) {
                        event.preventDefault();
                        focusTab(stripTabs[next].id);
                      }
                      if (event.key === "Delete" && tab.closable) {
                        event.preventDefault();
                        closeTab(tab.id);
                      }
                    }}
                  >
                    <tab.icon
                      size={15}
                      className="shrink-0 max-sm:hidden"
                      aria-hidden
                    />
                    <span className="truncate">{tab.name}</span>
                  </button>
                  {tab.closable && (
                    <button
                      aria-label={`Close ${tab.name} tab`}
                      onClick={() => closeTab(tab.id)}
                      className="mr-1 rounded p-1 max-sm:min-h-11 max-sm:min-w-11 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {!phone && (tabScroll.left || tabScroll.right) && (
            <div
              role="group"
              aria-label="Scroll computer tabs"
              className="mb-1 flex shrink-0"
            >
              <button
                aria-label="Scroll tabs left"
                title="Scroll tabs left"
                disabled={!tabScroll.left}
                onClick={() => scrollTabs(-1)}
                className="rounded p-1 hover:bg-muted disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                aria-label="Scroll tabs right"
                title="Scroll tabs right"
                disabled={!tabScroll.right}
                onClick={() => scrollTabs(1)}
                className="rounded p-1 hover:bg-muted disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          {phone && active === "files" && tabs.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  aria-label={`Open previews (${tabs.length})`}
                  className="mb-1 h-11 shrink-0 gap-1 px-2.5"
                >
                  <Files size={16} aria-hidden />
                  <span aria-hidden>{tabs.length}</span>
                  <ChevronDown size={14} aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-64 max-w-[calc(100vw-2rem)]"
                onEscapeKeyDown={(event) => event.stopPropagation()}
                onCloseAutoFocus={(event) => {
                  // The trigger unmounts with Files; focus moves to Back.
                  if (!previewPicked.current) return;
                  previewPicked.current = false;
                  event.preventDefault();
                }}
              >
                <DropdownMenuLabel>Open previews</DropdownMenuLabel>
                {tabs.map((tab) => (
                  <DropdownMenuItem
                    key={tab.id}
                    className="min-h-11"
                    title={tabTitle(tab)}
                    onSelect={() => {
                      previewPicked.current = true;
                      setActive(tab.id);
                    }}
                  >
                    <FileText size={16} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate">{tab.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {tabDetail(tab)}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!overlay && (
            <button
              ref={expandButton}
              aria-label={fullscreen ? "Exit full screen" : "Expand sidebar"}
              onClick={() => setExpanded(!expanded)}
              className="mb-1 shrink-0 rounded-md p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}
          <button
            aria-label={overlay ? "Close Computer" : "Minimize sidebar"}
            onClick={onClose}
            className="mb-1 shrink-0 rounded-md p-2 max-sm:min-h-11 max-sm:min-w-11 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            {overlay ? <X size={20} /> : <PanelRight size={16} />}
          </button>
        </div>
        <div className="min-h-0 flex-1 p-2 sm:p-3">
          <div
            role="tabpanel"
            id={`${prefix}-panel-activity`}
            aria-labelledby={`${prefix}-tab-activity`}
            hidden={active !== "activity"}
            className="h-full"
          >
            {activityContent ? (
              renderActivity(activityContent, open && active === "activity")
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Agent activity appears here when tools run.
              </div>
            )}
          </div>
          {filesVisited && (
            <div
              role="tabpanel"
              id={`${prefix}-panel-files`}
              aria-labelledby={`${prefix}-tab-files`}
              hidden={active !== "files"}
              className="h-full flex-col data-[active=true]:flex"
              data-active={active === "files"}
            >
              <WorkspaceFilesPanel
                chatId={chatId}
                messages={fileMessages}
                savedFilesLoading={saved.loading}
                onOpenCapturedFile={openCaptured}
                onOpenWorkspaceFile={openWorkspace}
              />
            </div>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role={phone ? "region" : "tabpanel"}
              id={`${prefix}-panel-${tab.id}`}
              aria-labelledby={
                phone ? `${prefix}-title` : `${prefix}-tab-${tab.id}`
              }
              hidden={active !== tab.id}
              className="h-full flex-col data-[active=true]:flex"
              data-active={active === tab.id}
            >
              {tab.kind === "captured" ? (
                (() => {
                  const file = captures.find(
                    (file) => file.id === tab.capturedId,
                  );
                  return file ? (
                    <CapturedFilePreview
                      file={file}
                      visible={open && active === tab.id}
                      compact={phone}
                      onClose={() => closeTab(tab.id)}
                    />
                  ) : saved.loading ? (
                    <p
                      role="status"
                      className="p-4 text-sm text-muted-foreground"
                    >
                      Loading saved files…
                    </p>
                  ) : (
                    <p
                      role="status"
                      className="p-4 text-sm text-muted-foreground"
                    >
                      This captured version is no longer in this chat.
                    </p>
                  );
                })()
              ) : (
                <LoadedFilePreview
                  loaded={tab.loaded}
                  compact={phone}
                  onClose={() => closeTab(tab.id)}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LoadedFilePreview({
  loaded,
  compact,
  onClose,
}: {
  loaded: LoadedWorkspaceFile;
  compact: boolean;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    setError("");
    const started = telemetryNow();
    const track = (
      outcome: "success" | "initiated" | "canceled" | "failed",
      reason?: "unsupported_native",
    ) =>
      trackWorkspaceFiles("workspace_file_download", {
        outcome,
        source: "workspace",
        file_kind: "workspace_snapshot",
        entry_point: "computer_files",
        reason,
        duration_ms: elapsedMs(started),
      });
    try {
      if (isTauriEnvironment()) {
        const result = await downloadFile({
          filename: loaded.file.name,
          content: loaded.bytes,
        });
        track(result.outcome, result.reason);
      } else {
        const url = URL.createObjectURL(new Blob([loaded.bytes]));
        const link = document.createElement("a");
        link.href = url;
        link.download = loaded.file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        track("initiated");
      }
    } catch (cause) {
      track("failed");
      setError(cause instanceof Error ? cause.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mb-2">
        <FileSourceDetails
          label={`${loaded.source} · Snapshot`}
          name="Snapshot details"
        >
          <p>
            Loaded from {loaded.source} at{" "}
            {new Date(loaded.loadedAt).toLocaleString()}.
          </p>
          <p>
            This tab keeps the version you opened. Reopen the file from Files to
            check for changes.
          </p>
        </FileSourceDetails>
      </div>
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <WorkspaceFilePreview
        file={loaded.file}
        busy={busy}
        compact={compact}
        onClose={onClose}
        onDownload={() => void download()}
      />
    </>
  );
}
