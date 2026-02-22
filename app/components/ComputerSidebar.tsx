import React from "react";
import {
  Minimize2,
  Terminal,
  Code2,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useState, useEffect, useRef, useMemo } from "react";
import { useGlobalState } from "../contexts/GlobalState";
import { ComputerCodeBlock } from "./ComputerCodeBlock";
import { TerminalCodeBlock } from "./TerminalCodeBlock";
import { DiffView } from "./DiffView";
import { CodeActionButtons } from "@/components/ui/code-action-buttons";
import { useSidebarNavigation } from "../hooks/useSidebarNavigation";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  isSidebarFile,
  isSidebarTerminal,
  isSidebarPython,
  isSidebarWebSearch,
  isSidebarNotes,
  type SidebarContent,
  type ChatStatus,
  type NoteCategory,
} from "@/types/chat";
import {
  getCategoryColor,
  getLanguageFromPath,
  getActionText,
  getSidebarIcon,
  getToolName,
  getDisplayTarget,
} from "./computer-sidebar-utils";

interface ComputerSidebarProps {
  sidebarOpen: boolean;
  sidebarContent: SidebarContent | null;
  closeSidebar: () => void;
  messages?: any[];
  onNavigate?: (content: SidebarContent) => void;
  status?: ChatStatus;
}

export const ComputerSidebarBase: React.FC<ComputerSidebarProps> = ({
  sidebarOpen,
  sidebarContent,
  closeSidebar,
  messages = [],
  onNavigate,
  status,
}) => {
  const [isWrapped, setIsWrapped] = useState(true);
  const previousToolCountRef = useRef<number>(0);

  const {
    toolExecutions,
    currentIndex,
    maxIndex,
    handlePrev,
    handleNext,
    handleJumpToLive,
    handleSliderClick,
    getProgressPercentage,
    isAtLive,
    canGoPrev,
    canGoNext,
  } = useSidebarNavigation({
    messages,
    sidebarContent,
    onNavigate,
  });

  // When showing a terminal, use live data from toolExecutions so streaming output updates in real time
  const resolvedTerminal = useMemo(() => {
    if (!sidebarContent || !isSidebarTerminal(sidebarContent)) return null;
    const live = toolExecutions.find(
      (item) =>
        isSidebarTerminal(item) &&
        item.toolCallId === sidebarContent.toolCallId,
    );
    return (live ?? sidebarContent) as typeof sidebarContent;
  }, [sidebarContent, toolExecutions]);

  // When showing a file, use live data from toolExecutions so streaming content updates in real time
  const resolvedFile = useMemo(() => {
    if (!sidebarContent || !isSidebarFile(sidebarContent)) return null;
    if (!sidebarContent.toolCallId) return sidebarContent;
    const live = toolExecutions.find(
      (item) =>
        isSidebarFile(item) && item.toolCallId === sidebarContent.toolCallId,
    );
    return (live ?? sidebarContent) as typeof sidebarContent;
  }, [sidebarContent, toolExecutions]);

  // Initialize tool count ref on mount
  useEffect(() => {
    if (sidebarOpen && toolExecutions.length > 0) {
      previousToolCountRef.current = toolExecutions.length;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally only sync on sidebar open/close, not on every tool execution
  }, [sidebarOpen]);

  // Auto-follow new tools when at live position during streaming
  useEffect(() => {
    if (!sidebarOpen || !onNavigate || toolExecutions.length === 0) {
      return;
    }

    const currentToolCount = toolExecutions.length;
    const previousToolCount = previousToolCountRef.current;

    // Check if new tools arrived (count increased)
    if (currentToolCount > previousToolCount) {
      // Check if we were at the last position before new tools arrived
      const wasAtLive = currentIndex === previousToolCount - 1;

      // Also check if we're currently at live (in case sidebarContent already updated)
      const isCurrentlyAtLive = currentIndex === currentToolCount - 1;

      // Auto-update if we were at live OR currently at live
      if (wasAtLive || isCurrentlyAtLive) {
        // Navigate to the latest tool execution
        // Since we only extract file operations when output is available,
        // content should always be ready
        const latestTool = toolExecutions[toolExecutions.length - 1];
        if (latestTool) {
          onNavigate(latestTool);
        }
      }
    }

    // Update the ref for next comparison
    previousToolCountRef.current = currentToolCount;
  }, [
    toolExecutions.length,
    currentIndex,
    sidebarOpen,
    onNavigate,
    toolExecutions,
  ]);

  // Handle deleted messages: close sidebar or navigate to latest when content no longer exists
  useEffect(() => {
    if (!sidebarOpen || !sidebarContent) {
      return;
    }

    // currentIndex === -1 means the current sidebarContent is not found in toolExecutions
    // This happens when the message containing this tool was deleted
    if (currentIndex === -1) {
      if (toolExecutions.length > 0 && onNavigate) {
        // Navigate to the latest available tool execution
        onNavigate(toolExecutions[toolExecutions.length - 1]);
      } else {
        // No tool executions left, close the sidebar
        closeSidebar();
      }
    }
  }, [
    currentIndex,
    sidebarOpen,
    sidebarContent,
    toolExecutions,
    onNavigate,
    closeSidebar,
  ]);

  if (!sidebarOpen || !sidebarContent) {
    return null;
  }

  const isFile = isSidebarFile(sidebarContent);
  const isTerminal = isSidebarTerminal(sidebarContent);
  const isPython = isSidebarPython(sidebarContent);
  const isWebSearch = isSidebarWebSearch(sidebarContent);
  const isNotes = isSidebarNotes(sidebarContent);

  // Use resolved versions for display metadata so streaming updates are reflected
  const displayContent =
    (isFile && resolvedFile) ||
    (isTerminal && resolvedTerminal) ||
    sidebarContent;

  const actionText = getActionText(displayContent);
  const icon = getSidebarIcon(displayContent);
  const toolName = getToolName(displayContent);
  const displayTarget = getDisplayTarget(displayContent);

  const handleClose = () => {
    closeSidebar();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleClose();
    }
  };

  const handleToggleWrap = () => {
    setIsWrapped(!isWrapped);
  };

  return (
    <div className="h-full w-full top-0 left-0 desktop:top-auto desktop:left-auto desktop:right-auto z-50 fixed desktop:relative desktop:h-full desktop:mr-4 flex-shrink-0">
      <div className="h-full w-full">
        <div className="shadow-[0px_0px_8px_0px_rgba(0,0,0,0.02)] border border-border/20 dark:border-border flex h-full w-full bg-background rounded-[22px]">
          <div className="flex-1 min-w-0 p-4 flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center gap-2 w-full">
              <div className="text-foreground text-lg font-semibold flex-1">
                HackerAI&apos;s Computer
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="w-7 h-7 relative rounded-md inline-flex items-center justify-center gap-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
                    aria-label="Minimize sidebar"
                    tabIndex={0}
                    onKeyDown={handleKeyDown}
                  >
                    <Minimize2 className="w-5 h-5 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Minimize</TooltipContent>
              </Tooltip>
            </div>

            {/* Action Status */}
            <div className="flex items-center gap-2 mt-2">
              <div className="w-[40px] h-[40px] bg-muted/50 rounded-lg flex items-center justify-center flex-shrink-0">
                {icon}
              </div>
              <div className="flex-1 flex flex-col gap-1 min-w-0">
                <div className="text-[12px] text-muted-foreground">
                  HackerAI is using{" "}
                  <span className="text-foreground">{toolName}</span>
                </div>
                <div
                  title={`${actionText} ${displayTarget}`}
                  className="max-w-[100%] w-[max-content] truncate text-[13px] rounded-full inline-flex items-center px-[10px] py-[3px] border border-border bg-muted/30 text-foreground"
                >
                  {actionText}
                  <span className="flex-1 min-w-0 px-1 ml-1 text-[12px] font-mono max-w-full text-ellipsis overflow-hidden whitespace-nowrap text-muted-foreground">
                    <code>{displayTarget}</code>
                  </span>
                </div>
              </div>
            </div>

            {/* Content Container */}
            <div className="flex flex-col rounded-lg overflow-hidden bg-muted/20 border border-border/30 dark:border-black/30 shadow-[0px_4px_32px_0px_rgba(0,0,0,0.04)] flex-1 min-h-0 mt-[16px]">
              {/* Unified Header */}
              <div className="h-[36px] flex items-center justify-between px-3 w-full bg-muted/30 border-b border-border rounded-t-lg shadow-[inset_0px_1px_0px_0px_rgba(255,255,255,0.1)]">
                {/* Title - far left */}
                <div className="flex items-center gap-2">
                  {isTerminal ? (
                    sidebarContent.session || sidebarContent.pid ? (
                      <div className="max-w-[250px] truncate text-muted-foreground text-sm font-medium">
                        {sidebarContent.session ?? `PID ${sidebarContent.pid}`}
                      </div>
                    ) : (
                      <Terminal
                        size={14}
                        className="text-muted-foreground flex-shrink-0"
                      />
                    )
                  ) : isPython ? (
                    <Code2
                      size={14}
                      className="text-muted-foreground flex-shrink-0"
                    />
                  ) : isWebSearch ? (
                    <div className="max-w-[250px] truncate text-muted-foreground text-sm font-medium text-center">
                      Search
                    </div>
                  ) : isNotes ? (
                    <div className="max-w-[250px] truncate text-muted-foreground text-sm font-medium">
                      Notes
                    </div>
                  ) : isFile && resolvedFile?.action === "searching" ? (
                    <div className="max-w-[250px] truncate text-muted-foreground text-sm font-medium">
                      Search Results
                    </div>
                  ) : isFile && resolvedFile ? (
                    <div className="max-w-[250px] truncate text-muted-foreground text-sm font-medium">
                      {resolvedFile.path.split("/").pop() || resolvedFile.path}
                    </div>
                  ) : null}
                </div>

                {/* Action buttons - far right */}
                {!isWebSearch && !isNotes && (
                  <CodeActionButtons
                    content={
                      isFile && resolvedFile
                        ? resolvedFile.content
                        : isPython
                          ? sidebarContent.code
                          : isTerminal && resolvedTerminal
                            ? resolvedTerminal.output
                              ? `$ ${resolvedTerminal.command}\n${resolvedTerminal.output}`
                              : `$ ${resolvedTerminal.command}`
                            : ""
                    }
                    filename={
                      isFile
                        ? sidebarContent.action === "searching"
                          ? "search-results.txt"
                          : sidebarContent.path.split("/").pop() || "code.txt"
                        : isPython
                          ? "python-code.py"
                          : "terminal-output.txt"
                    }
                    language={
                      isFile
                        ? sidebarContent.action === "searching"
                          ? "text"
                          : sidebarContent.language ||
                            getLanguageFromPath(sidebarContent.path)
                        : isPython
                          ? "python"
                          : "ansi"
                    }
                    isWrapped={isWrapped}
                    onToggleWrap={handleToggleWrap}
                    variant="sidebar"
                  />
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-h-0 w-full overflow-hidden bg-background">
                <div className="flex flex-col min-h-0 h-full relative">
                  <div className="focus-visible:outline-none flex-1 min-h-0 h-full text-sm flex flex-col py-0 outline-none">
                    <div
                      className="font-mono w-full text-xs leading-[18px] flex-1 min-h-0 h-full min-w-0"
                      style={{
                        overflowWrap: "break-word",
                        wordBreak: "break-word",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {isFile && resolvedFile && (
                        <>
                          {/* Show DiffView for editing/appending actions with diff data */}
                          {(resolvedFile.action === "editing" ||
                            resolvedFile.action === "appending") &&
                          resolvedFile.originalContent !== undefined &&
                          resolvedFile.modifiedContent !== undefined ? (
                            <DiffView
                              originalContent={resolvedFile.originalContent}
                              modifiedContent={resolvedFile.modifiedContent}
                              language={
                                resolvedFile.language ||
                                getLanguageFromPath(resolvedFile.path)
                              }
                              wrap={isWrapped}
                            />
                          ) : (
                            <ComputerCodeBlock
                              language={
                                resolvedFile.action === "searching"
                                  ? "text"
                                  : resolvedFile.language ||
                                    getLanguageFromPath(resolvedFile.path)
                              }
                              wrap={isWrapped}
                              showButtons={false}
                            >
                              {resolvedFile.content}
                            </ComputerCodeBlock>
                          )}
                        </>
                      )}
                      {isTerminal && resolvedTerminal && (
                        <TerminalCodeBlock
                          command={resolvedTerminal.command}
                          output={resolvedTerminal.output}
                          isExecuting={resolvedTerminal.isExecuting}
                          isBackground={resolvedTerminal.isBackground}
                          status={
                            resolvedTerminal.isExecuting ? "streaming" : "ready"
                          }
                          variant="sidebar"
                          wrap={isWrapped}
                        />
                      )}
                      {isPython && (
                        <div className="h-full overflow-auto">
                          <div className="pb-4">
                            <ComputerCodeBlock
                              language="python"
                              wrap={isWrapped}
                              showButtons={false}
                            >
                              {sidebarContent.code}
                            </ComputerCodeBlock>
                          </div>
                          {sidebarContent.output && (
                            <>
                              <div className="border-t border-border/30 mb-3" />
                              <div className="px-4 pb-4">
                                <div className="text-xs text-muted-foreground font-semibold mb-3">
                                  Result:
                                </div>
                                <ComputerCodeBlock
                                  language="text"
                                  wrap={isWrapped}
                                  showButtons={false}
                                >
                                  {sidebarContent.output}
                                </ComputerCodeBlock>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      {isWebSearch && (
                        <div className="flex-1 min-h-0 h-full overflow-y-auto">
                          <div className="flex flex-col px-4 py-3">
                            {sidebarContent.isSearching ? (
                              <div className="flex items-center justify-center py-8">
                                <div className="text-muted-foreground text-sm">
                                  Searching...
                                </div>
                              </div>
                            ) : sidebarContent.results.length === 0 ? (
                              <div className="flex items-center justify-center py-8">
                                <div className="text-muted-foreground text-sm">
                                  No results found
                                </div>
                              </div>
                            ) : (
                              sidebarContent.results.map((result, index) => (
                                <div
                                  key={`${result.url}-${index}`}
                                  className={`py-3 ${index === 0 ? "pt-0" : ""} ${index < sidebarContent.results.length - 1 ? "border-b border-border/30" : ""}`}
                                >
                                  <a
                                    href={result.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block text-foreground text-sm font-medium hover:underline line-clamp-2 cursor-pointer"
                                  >
                                    <img
                                      width={16}
                                      height={16}
                                      alt="favicon"
                                      className="float-left mr-2 mt-0.5 rounded-full border border-border"
                                      src={`https://s2.googleusercontent.com/s2/favicons?domain=${encodeURIComponent(result.url)}&sz=32`}
                                    />
                                    {result.title}
                                  </a>
                                  {result.content && (
                                    <div className="text-muted-foreground text-xs mt-0.5 line-clamp-3">
                                      {result.content}
                                    </div>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                      {isNotes && (
                        <div className="flex-1 min-h-0 h-full overflow-y-auto">
                          <div className="flex flex-col px-4 py-3">
                            {sidebarContent.isExecuting ? (
                              <div className="flex items-center justify-center py-8">
                                <div className="text-muted-foreground text-sm">
                                  Processing...
                                </div>
                              </div>
                            ) : sidebarContent.action === "update" &&
                              sidebarContent.modified ? (
                              // Update action: show before/after comparison
                              <div className="space-y-4">
                                {sidebarContent.original && (
                                  <div>
                                    <div className="text-xs text-muted-foreground font-medium mb-2">
                                      Before
                                    </div>
                                    <div className="bg-muted/30 rounded-md p-3">
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="text-foreground text-sm font-medium">
                                          {sidebarContent.original.title}
                                        </span>
                                        <span
                                          className={`text-xs flex-shrink-0 ${getCategoryColor(sidebarContent.original.category as NoteCategory)}`}
                                        >
                                          {sidebarContent.original.category}
                                        </span>
                                      </div>
                                      <div className="text-muted-foreground text-sm whitespace-pre-wrap">
                                        {sidebarContent.original.content}
                                      </div>
                                      {sidebarContent.original.tags.length >
                                        0 && (
                                        <div className="flex gap-1 mt-2 flex-wrap">
                                          {sidebarContent.original.tags.map(
                                            (tag) => (
                                              <span
                                                key={tag}
                                                className="text-xs bg-muted px-1.5 py-0.5 rounded"
                                              >
                                                {tag}
                                              </span>
                                            ),
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                                <div>
                                  <div className="text-xs text-muted-foreground font-medium mb-2">
                                    After
                                  </div>
                                  <div className="bg-muted/30 rounded-md p-3">
                                    <div className="flex items-center gap-2 mb-1">
                                      <span className="text-foreground text-sm font-medium">
                                        {sidebarContent.modified.title}
                                      </span>
                                      <span
                                        className={`text-xs flex-shrink-0 ${getCategoryColor(sidebarContent.modified.category as NoteCategory)}`}
                                      >
                                        {sidebarContent.modified.category}
                                      </span>
                                    </div>
                                    <div className="text-muted-foreground text-sm whitespace-pre-wrap">
                                      {sidebarContent.modified.content}
                                    </div>
                                    {sidebarContent.modified.tags.length >
                                      0 && (
                                      <div className="flex gap-1 mt-2 flex-wrap">
                                        {sidebarContent.modified.tags.map(
                                          (tag) => (
                                            <span
                                              key={tag}
                                              className="text-xs bg-muted px-1.5 py-0.5 rounded"
                                            >
                                              {tag}
                                            </span>
                                          ),
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            ) : sidebarContent.action === "delete" ? (
                              // Delete action: show confirmation
                              <div className="flex items-center justify-center py-8">
                                <div className="text-muted-foreground text-sm">
                                  Note &quot;{sidebarContent.affectedTitle}
                                  &quot; deleted
                                </div>
                              </div>
                            ) : sidebarContent.notes.length === 0 ? (
                              <div className="flex items-center justify-center py-8">
                                <div className="text-muted-foreground text-sm">
                                  No notes found
                                </div>
                              </div>
                            ) : (
                              sidebarContent.notes.map((note, index) => (
                                <div
                                  key={note.note_id}
                                  className={`py-3 ${index === 0 ? "pt-0" : ""} ${index < sidebarContent.notes.length - 1 ? "border-b border-border/30" : ""}`}
                                >
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-foreground text-sm font-medium">
                                      {note.title}
                                    </span>
                                    <span
                                      className={`text-xs flex-shrink-0 ${getCategoryColor(note.category)}`}
                                    >
                                      {note.category}
                                    </span>
                                  </div>
                                  <div className="text-muted-foreground text-sm whitespace-pre-wrap">
                                    {note.content}
                                  </div>
                                  {note.tags.length > 0 && (
                                    <div className="flex gap-1 mt-2 flex-wrap">
                                      {note.tags.map((tag) => (
                                        <span
                                          key={tag}
                                          className="text-xs bg-muted px-1.5 py-0.5 rounded"
                                        >
                                          {tag}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Navigation Footer */}
              <div className="mt-auto flex w-full items-center gap-2 px-4 h-[44px] relative bg-background border-t border-border">
                <div className="flex items-center" dir="ltr">
                  <button
                    type="button"
                    onClick={handlePrev}
                    disabled={!canGoPrev}
                    className={`flex items-center justify-center w-[24px] h-[24px] transition-colors cursor-pointer ${
                      !canGoPrev
                        ? "text-muted-foreground/30 cursor-not-allowed"
                        : "text-muted-foreground hover:text-blue-500"
                    }`}
                    aria-label="Previous tool execution"
                  >
                    <SkipBack size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={handleNext}
                    disabled={!canGoNext}
                    className={`flex items-center justify-center w-[24px] h-[24px] transition-colors cursor-pointer ${
                      !canGoNext
                        ? "text-muted-foreground/30 cursor-not-allowed"
                        : "text-muted-foreground hover:text-blue-500"
                    }`}
                    aria-label="Next tool execution"
                  >
                    <SkipForward size={16} />
                  </button>
                </div>
                <div
                  className="group touch-none group relative hover:z-10 flex h-1 flex-1 min-w-0 cursor-pointer select-none items-center"
                  onClick={handleSliderClick}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      // Focus the slider handle for keyboard navigation
                      const handle = e.currentTarget.querySelector(
                        '[role="slider"]',
                      ) as HTMLElement;
                      handle?.focus();
                    }
                  }}
                >
                  <span className="relative h-full w-full rounded-full bg-muted">
                    <span
                      className="absolute h-full rounded-full bg-blue-500"
                      style={{
                        left: "0%",
                        width: `${getProgressPercentage}%`,
                      }}
                    ></span>
                  </span>
                  {currentIndex >= 0 && (
                    <span
                      className="absolute -translate-x-1/2 p-[3px]"
                      style={{
                        left: `${getProgressPercentage}%`,
                      }}
                    >
                      <span
                        role="slider"
                        tabIndex={0}
                        aria-valuemin={0}
                        aria-valuemax={maxIndex}
                        aria-valuenow={currentIndex}
                        aria-label={`Tool execution ${currentIndex + 1}`}
                        className="relative block h-[14px] w-[14px] rounded-full bg-blue-500 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 border-2 border-background drop-shadow-[0px_1px_4px_rgba(0,0,0,0.06)]"
                      ></span>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 text-sm ms-[2px] cursor-default">
                  <div
                    className={`h-[8px] w-[8px] rounded-full ${
                      status === "streaming"
                        ? "bg-green-500"
                        : "bg-muted-foreground"
                    }`}
                  ></div>
                  <span
                    className={
                      status === "streaming"
                        ? "text-foreground"
                        : "text-muted-foreground"
                    }
                  >
                    live
                  </span>
                </div>
                {!isAtLive && (
                  <button
                    onClick={handleJumpToLive}
                    className="h-10 px-4 border border-border flex items-center gap-2 bg-background hover:bg-muted shadow-[0px_5px_16px_0px_rgba(0,0,0,0.1),0px_0px_1.25px_0px_rgba(0,0,0,0.1)] rounded-full cursor-pointer absolute left-[50%] translate-x-[-50%]"
                    style={{ bottom: "calc(100% + 10px)" }}
                    aria-label="Jump to live"
                  >
                    <Play size={16} className="text-foreground" />
                    <span className="text-foreground text-sm font-medium">
                      Jump to live
                    </span>
                  </button>
                )}
                <div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Wrapper for normal chats using GlobalState
export const ComputerSidebar: React.FC<{
  messages?: any[];
  status?: ChatStatus;
}> = ({ messages, status }) => {
  const { sidebarOpen, sidebarContent, closeSidebar, openSidebar } =
    useGlobalState();

  return (
    <ComputerSidebarBase
      sidebarOpen={sidebarOpen}
      sidebarContent={sidebarContent}
      closeSidebar={closeSidebar}
      messages={messages}
      onNavigate={openSidebar}
      status={status}
    />
  );
};
