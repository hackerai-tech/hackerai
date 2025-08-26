import React from "react";
import { Minimize2, Edit, Terminal } from "lucide-react";
import { useState } from "react";
import { useGlobalState } from "../contexts/GlobalState";
import { ComputerCodeBlock } from "./ComputerCodeBlock";
import { TerminalCodeBlock } from "./TerminalCodeBlock";
import { CodeActionButtons } from "@/components/ui/code-action-buttons";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { isSidebarFile, isSidebarTerminal } from "@/types/chat";

export const ComputerSidebar: React.FC = () => {
  const { sidebarOpen, sidebarContent, closeSidebar } = useGlobalState();
  const [isWrapped, setIsWrapped] = useState(true);

  if (!sidebarOpen || !sidebarContent) {
    return null;
  }

  const isFile = isSidebarFile(sidebarContent);
  const isTerminal = isSidebarTerminal(sidebarContent);

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
      return sidebarContent.isExecuting
        ? "Executing command"
        : "Command executed";
    }
    return "Unknown action";
  };

  const getIcon = () => {
    if (isFile) {
      return <Edit className="w-5 h-5 text-muted-foreground" />;
    } else if (isTerminal) {
      return <Terminal className="w-5 h-5 text-muted-foreground" />;
    }
    return <Edit className="w-5 h-5 text-muted-foreground" />;
  };

  const getToolName = (): string => {
    if (isFile) {
      return "Editor";
    } else if (isTerminal) {
      return "Terminal";
    }
    return "Tool";
  };

  const getDisplayTarget = (): string => {
    if (isFile) {
      return sidebarContent.path.split("/").pop() || sidebarContent.path;
    } else if (isTerminal) {
      return sidebarContent.command;
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
                      : sidebarContent.output
                        ? `$ ${sidebarContent.command}\n${sidebarContent.output}`
                        : `$ ${sidebarContent.command}`
                  }
                  filename={
                    isFile
                      ? sidebarContent.path.split("/").pop() || "code.txt"
                      : "terminal-output.txt"
                  }
                  language={
                    isFile
                      ? sidebarContent.language ||
                        getLanguageFromPath(sidebarContent.path)
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
                          status={
                            sidebarContent.isExecuting ? "streaming" : "ready"
                          }
                          variant="sidebar"
                          wrap={isWrapped}
                        />
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
