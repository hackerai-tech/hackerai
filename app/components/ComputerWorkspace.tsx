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
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Maximize2,
  Minimize2,
  Monitor,
  PanelRight,
  Plus,
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
import { CapturedFilePreview } from "./ChatFilesPanel";
import {
  WorkspaceFilesPanel,
  type LoadedWorkspaceFile,
} from "./WorkspaceFilesPanel";
import WorkspaceFilePreview from "./WorkspaceFilePreview";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { downloadFile } from "@/lib/utils/file-download";
import { isTauriEnvironment } from "../hooks/useTauri";
import { useComputerSidebarOverlay } from "@/hooks/use-workspace-layout";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  const fullscreen = expanded && !overlay;
  const frame = useRef<HTMLDivElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });
  const expandButton = useRef<HTMLButtonElement>(null);
  const [lastRequest, setLastRequest] = useState<number | null>(null);
  const [previousSelection, setPreviousSelection] = useState(selection);
  const ownedUrls = useRef(new Map<string, string>());
  const captures = useMemo(() => collectChatFiles(messages), [messages]);
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

  // Reconcile explicit open requests before rendering the selected panel. Streaming
  // updates and Activity timeline navigation retain the user's selected tab.
  if (selection !== previousSelection) {
    setPreviousSelection(selection);
    if (selection && !isSidebarWorkspaceFiles(selection))
      setActivity(selection);
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

  useEffect(() => {
    if (!open) return;
    const tab = document.getElementById(`${prefix}-tab-${active}`);
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    tab?.focus({ preventScroll: true });
  }, [active, open, prefix, overlay]);

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
    if (!open || !strip) return;
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
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(strip);
    strip.addEventListener("scroll", update, { passive: true });
    return () => {
      observer?.disconnect();
      strip.removeEventListener("scroll", update);
    };
  }, [open, tabs.length]);

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
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[22px] border border-border/40 bg-background">
        <div className="flex min-w-0 items-center gap-1 border-b bg-muted/20 px-2 pt-2">
          <div
            ref={tabStrip}
            role="tablist"
            aria-label="Computer tabs"
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          >
            {visibleTabs.map((tab, index) => (
              <div
                key={tab.id}
                className={`flex max-w-48 shrink-0 items-center rounded-t-lg border border-b-0 ${active === tab.id ? "border-border bg-background" : "border-transparent text-muted-foreground hover:bg-muted/60"}`}
              >
                <button
                  role="tab"
                  id={`${prefix}-tab-${tab.id}`}
                  aria-controls={`${prefix}-panel-${tab.id}`}
                  aria-selected={active === tab.id}
                  tabIndex={active === tab.id ? 0 : -1}
                  title={
                    "kind" in tab
                      ? tab.kind === "workspace"
                        ? `${tab.loaded.file.path} · ${tab.loaded.source}`
                        : (() => {
                            const capture = captures.find(
                              (file) => file.id === tab.capturedId,
                            );
                            return capture
                              ? `${capture.path} · Captured from ${capture.source}`
                              : tab.name;
                          })()
                      : tab.name
                  }
                  onClick={() => focusTab(tab.id)}
                  className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onKeyDown={(event) => {
                    let next: number | undefined;
                    if (event.key === "ArrowRight")
                      next = (index + 1) % visibleTabs.length;
                    if (event.key === "ArrowLeft")
                      next =
                        (index - 1 + visibleTabs.length) % visibleTabs.length;
                    if (event.key === "Home") next = 0;
                    if (event.key === "End") next = visibleTabs.length - 1;
                    if (next !== undefined) {
                      event.preventDefault();
                      focusTab(visibleTabs[next].id);
                    }
                    if (event.key === "Delete" && tab.closable) {
                      event.preventDefault();
                      closeTab(tab.id);
                    }
                  }}
                >
                  <tab.icon size={15} className="shrink-0" aria-hidden />
                  <span className="truncate">{tab.name}</span>
                </button>
                {tab.closable && (
                  <button
                    aria-label={`Close ${tab.name} tab`}
                    onClick={() => closeTab(tab.id)}
                    className="mr-1 rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {(tabScroll.left || tabScroll.right) && (
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label="Open computer tab"
                title="Open tab"
                className="mb-1 shrink-0 rounded-md p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onEscapeKeyDown={(event) => event.stopPropagation()}
            >
              <DropdownMenuItem onSelect={openFiles}>
                <FolderOpen size={16} /> Files
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => focusTab("activity")}>
                <Monitor size={16} /> Activity
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
            aria-label="Minimize sidebar"
            onClick={onClose}
            className="mb-1 shrink-0 rounded-md p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PanelRight size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 p-3">
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
                messages={messages}
                onOpenCapturedFile={openCaptured}
                onOpenWorkspaceFile={openWorkspace}
              />
            </div>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tabpanel"
              id={`${prefix}-panel-${tab.id}`}
              aria-labelledby={`${prefix}-tab-${tab.id}`}
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
                      onClose={() => closeTab(tab.id)}
                    />
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
  onClose,
}: {
  loaded: LoadedWorkspaceFile;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      if (isTauriEnvironment()) {
        if (loaded.file.text === undefined)
          throw new Error(
            "Binary downloads are available in the web app. Desktop can save UTF-8 text files here.",
          );
        const result = await downloadFile({
          filename: loaded.file.name,
          content: loaded.file.text,
        });
        captureAuthenticatedEvent("workspace_file_download", {
          outcome: result.outcome,
          surface: "desktop",
        });
      } else {
        const url = URL.createObjectURL(new Blob([loaded.bytes]));
        const link = document.createElement("a");
        link.href = url;
        link.download = loaded.file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        captureAuthenticatedEvent("workspace_file_download", {
          outcome: "initiated",
          surface: "web",
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="mb-3 text-xs text-muted-foreground">
        Loaded from {loaded.source} at{" "}
        {new Date(loaded.loadedAt).toLocaleTimeString()}. This tab keeps the
        version you opened; reopen from Files to check for changes.
      </p>
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <WorkspaceFilePreview
        file={loaded.file}
        busy={busy}
        onClose={onClose}
        onDownload={() => void download()}
      />
    </>
  );
}
