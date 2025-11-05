import React from "react";
import { Minimize2, Edit, Terminal, Code2 } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useGlobalState } from "../contexts/GlobalState";
import { ComputerCodeBlock } from "./ComputerCodeBlock";
import { TerminalCodeBlock } from "./TerminalCodeBlock";
import { CodeActionButtons } from "@/components/ui/code-action-buttons";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  isSidebarFile,
  isSidebarTerminal,
  isSidebarPython,
} from "@/types/chat";

export const ComputerSidebar: React.FC = () => {
  const { sidebarOpen, sidebarContent, closeSidebar } = useGlobalState();
  const [isWrapped, setIsWrapped] = useState(true);

  // State for tracking background process status
  const [isProcessRunning, setIsProcessRunning] = useState<boolean | null>(null);
  const [isKilling, setIsKilling] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  if (!sidebarOpen || !sidebarContent) {
    return null;
  }

  const isFile = isSidebarFile(sidebarContent);
  const isTerminal = isSidebarTerminal(sidebarContent);
  const isPython = isSidebarPython(sidebarContent);

  // Get PID for terminal commands
  const pid = isTerminal && sidebarContent.isBackground && sidebarContent.pid
    ? sidebarContent.pid
    : null;

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
      };
      return actionMap[sidebarContent.action || "reading"];
    } else if (isTerminal) {
      const baseText = sidebarContent.isExecuting
        ? "Executing command"
        : "Command executed";
      return sidebarContent.isBackground ? `${baseText} (background)` : baseText;
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

  // Poll API to check if background process is still running
  useEffect(() => {
    if (!isTerminal || !sidebarContent.isBackground || !pid || !sidebarContent.command) {
      return;
    }

    // Initial check
    const checkProcessStatus = async () => {
      try {
        const response = await fetch("/api/check-process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pid,
            command: sidebarContent.command,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          setIsProcessRunning(data.running);

          // Stop polling if process is no longer running
          if (!data.running && pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        }
      } catch (error) {
        console.error("Error checking process status:", error);
      }
    };

    // Check immediately
    checkProcessStatus();

    // Set up polling every 5 seconds
    pollIntervalRef.current = setInterval(checkProcessStatus, 5000);

    // Cleanup on unmount
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [pid, isTerminal, sidebarContent]);

  const handleKillProcess = async () => {
    if (!pid || isKilling) return;

    setIsKilling(true);

    try {
      const response = await fetch("/api/kill-process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setIsProcessRunning(false);
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        }
      }
    } catch (error) {
      console.error("Error killing process:", error);
    } finally {
      setIsKilling(false);
    }
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
                <div className="flex items-center gap-1">
                  <div
                    title={`${getActionText()} ${getDisplayTarget()}`}
                    className="max-w-[100%] w-[max-content] truncate text-[13px] rounded-full inline-flex items-center px-[10px] py-[3px] border border-border bg-muted/30 text-foreground"
                  >
                    {getActionText()}
                    <span className="flex-1 min-w-0 px-1 ml-1 text-[12px] font-mono max-w-full text-ellipsis overflow-hidden whitespace-nowrap text-muted-foreground">
                      <code>{getDisplayTarget()}</code>
                    </span>
                  </div>
                  {/* Status badge for background processes */}
                  {isTerminal && sidebarContent.isBackground && pid && isProcessRunning && (
                    <>
                      <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 flex-shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-600 dark:bg-green-400 animate-pulse"></span>
                        {isKilling ? "Killing..." : "Running"}
                      </span>
                      <span
                        onClick={handleKillProcess}
                        className={`w-4 h-4 bg-red-500 hover:bg-red-600 rounded-sm flex items-center justify-center transition-all cursor-pointer ${
                          isKilling ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                        title={isKilling ? "Killing process..." : "Kill process"}
                        role="button"
                        aria-label={isKilling ? "Killing process..." : "Kill process"}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if ((e.key === "Enter" || e.key === " ") && !isKilling) {
                            e.preventDefault();
                            handleKillProcess();
                          }
                        }}
                      >
                        {isKilling ? (
                          <span className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                        ) : (
                          <span className="text-white text-[10px] font-bold leading-none">×</span>
                        )}
                      </span>
                    </>
                  )}
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
              <div className="flex-1 min-h-0 w-full overflow-hidden">
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
                      {isTerminal && (
                        <TerminalCodeBlock
                          command={sidebarContent.command}
                          output={sidebarContent.output}
                          isExecuting={sidebarContent.isExecuting}
                          isBackground={sidebarContent.isBackground}
                          pid={sidebarContent.pid}
                          isProcessRunning={isProcessRunning}
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
