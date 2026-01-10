import React from "react";
import {
  Minimize2,
  Edit,
  Terminal,
  Code2,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
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
  type SidebarContent,
  type ChatStatus,
} from "@/types/chat";

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

  if (!sidebarOpen || !sidebarContent) {
    return null;
  }

  const isFile = isSidebarFile(sidebarContent);
  const isTerminal = isSidebarTerminal(sidebarContent);
  const isPython = isSidebarPython(sidebarContent);

  const getLanguageFromPath = (filePath: string): string => {
    const extension = filePath.split(".").pop()?.toLowerCase() || "";
    const languageMap: Record<string, string> = {
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      py: "python",
      rb: "ruby",
      go: "go",
      rs: "rust",
      java: "java",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      css: "css",
      scss: "scss",
      sass: "sass",
      html: "html",
      xml: "xml",
      json: "json",
      yaml: "yaml",
      yml: "yaml",
      md: "markdown",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      fish: "bash",
      sql: "sql",
      php: "php",
      swift: "swift",
      kt: "kotlin",
      scala: "scala",
      clj: "clojure",
      hs: "haskell",
      elm: "elm",
      vue: "vue",
      svelte: "svelte",
    };
    return languageMap[extension] || "text";
  };

  const getActionText = (): string => {
    if (isFile) {
      const actionMap = {
        reading: "Reading file",
        creating: "Creating file",
        editing: "Editing file",
        writing: "Writing file",
        searching: "Search results",
      };
      return actionMap[sidebarContent.action || "reading"];
    } else if (isTerminal) {
      return sidebarContent.isExecuting
        ? "Executing command"
        : "Command executed";
    } else if (isPython) {
      return sidebarContent.isExecuting
        ? "Executing Python"
        : "Python executed";
    }
    return "Unknown action";
  };

  const getIcon = () => {
    if (isFile) {
      return <Edit className="w-5 h-5 text-muted-foreground" />;
    } else if (isTerminal) {
      return <Terminal className="w-5 h-5 text-muted-foreground" />;
    } else if (isPython) {
      return <Code2 className="w-5 h-5 text-muted-foreground" />;
    }
    return <Edit className="w-5 h-5 text-muted-foreground" />;
  };

  const getToolName = (): string => {
    if (isFile) {
      return "Editor";
    } else if (isTerminal) {
      return "Terminal";
    } else if (isPython) {
      return "Python";
    }
    return "Tool";
  };

  const getDisplayTarget = (): string => {
    if (isFile) {
      return sidebarContent.path.split("/").pop() || sidebarContent.path;
    } else if (isTerminal) {
      return sidebarContent.command;
    } else if (isPython) {
      return sidebarContent.code.replace(/\n/g, " ");
    }
    return "";
  };

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
                {getIcon()}
              </div>
              <div className="flex-1 flex flex-col gap-1 min-w-0">
                <div className="text-[12px] text-muted-foreground">
                  HackerAI is using{" "}
                  <span className="text-foreground">{getToolName()}</span>
                </div>
                <div
                  title={`${getActionText()} ${getDisplayTarget()}`}
                  className="max-w-[100%] w-[max-content] truncate text-[13px] rounded-full inline-flex items-center px-[10px] py-[3px] border border-border bg-muted/30 text-foreground"
                >
                  {getActionText()}
                  <span className="flex-1 min-w-0 px-1 ml-1 text-[12px] font-mono max-w-full text-ellipsis overflow-hidden whitespace-nowrap text-muted-foreground">
                    <code>{getDisplayTarget()}</code>
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
                    <Terminal
                      size={14}
                      className="text-muted-foreground flex-shrink-0"
                    />
                  ) : isPython ? (
                    <Code2
                      size={14}
                      className="text-muted-foreground flex-shrink-0"
                    />
                  ) : (
                    <div className="max-w-[250px] truncate text-muted-foreground text-sm font-medium">
                      {sidebarContent.path.split("/").pop() ||
                        sidebarContent.path}
                    </div>
                  )}
                </div>

                {/* Action buttons - far right */}
                <CodeActionButtons
                  content={
                    isFile
                      ? sidebarContent.content
                      : isPython
                        ? sidebarContent.code
                        : sidebarContent.output
                          ? `$ ${sidebarContent.command}\n${sidebarContent.output}`
                          : `$ ${sidebarContent.command}`
                  }
                  filename={
                    isFile
                      ? sidebarContent.path.split("/").pop() || "code.txt"
                      : isPython
                        ? "python-code.py"
                        : "terminal-output.txt"
                  }
                  language={
                    isFile
                      ? sidebarContent.language ||
                        getLanguageFromPath(sidebarContent.path)
                      : isPython
                        ? "python"
                        : "ansi"
                  }
                  isWrapped={isWrapped}
                  onToggleWrap={handleToggleWrap}
                  variant="sidebar"
                />
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
                      {isFile && (
                        <>
                          {/* Show DiffView for editing actions with diff data */}
                          {sidebarContent.action === "editing" &&
                          sidebarContent.originalContent &&
                          sidebarContent.modifiedContent ? (
                            <DiffView
                              originalContent={sidebarContent.originalContent}
                              modifiedContent={sidebarContent.modifiedContent}
                              language={
                                sidebarContent.language ||
                                getLanguageFromPath(sidebarContent.path)
                              }
                              wrap={isWrapped}
                            />
                          ) : (
                            <ComputerCodeBlock
                              language={
                                sidebarContent.language ||
                                getLanguageFromPath(sidebarContent.path)
                              }
                              wrap={isWrapped}
                              showButtons={false}
                            >
                              {sidebarContent.content}
                            </ComputerCodeBlock>
                          )}
                        </>
                      )}
                      {isTerminal && (
                        <TerminalCodeBlock
                          command={sidebarContent.command}
                          output={sidebarContent.output}
                          isExecuting={sidebarContent.isExecuting}
                          isBackground={sidebarContent.isBackground}
                          status={
                            sidebarContent.isExecuting ? "streaming" : "ready"
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
