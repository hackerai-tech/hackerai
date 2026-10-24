"use client";

import { useState } from "react";
import { Maximize2, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CodeActionButtons } from "@/components/ui/code-action-buttons";
import { TerminalCodeBlock } from "./TerminalCodeBlock";
import { isInteractiveShellAction } from "./tools/shell-tool-utils";
import type { SidebarTerminal } from "@/types/chat";

/** Inspect one selected execution without the browser preview consuming its space. */
export function ExpandedTerminalButton({
  terminal,
  onExpand,
}: {
  terminal: SidebarTerminal;
  onExpand: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [wrap, setWrap] = useState(true);
  // Interactive terminal snapshots may omit the original command or input.
  const separateCommand =
    terminal.rawBytes !== undefined ||
    isInteractiveShellAction(terminal.shellAction);
  const content = terminal.output
    ? `$ ${terminal.command}\n${terminal.output}`
    : `$ ${terminal.command}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onExpand();
        setOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label="Expand command and output"
              className="inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs transition-colors text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Maximize2 size={14} aria-hidden />
            </button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Expand command and output</TooltipContent>
      </Tooltip>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:h-[90dvh] sm:max-w-[min(96vw,1200px)] sm:rounded-xl"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 pt-[env(safe-area-inset-top)]">
          <DialogTitle className="text-base">Command and output</DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close expanded command"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={18} aria-hidden />
            </button>
          </DialogClose>
        </div>
        <div className="flex shrink-0 justify-end border-b px-2 py-1 [&_button]:min-h-11 [&_button]:min-w-11">
          <CodeActionButtons
            content={content}
            filename="terminal-output.txt"
            language="ansi"
            variant="sidebar"
            isWrapped={wrap}
            onToggleWrap={() => setWrap((value) => !value)}
            showWrap={terminal.rawBytes === undefined}
          />
        </div>
        {separateCommand && (
          <div className="max-h-[35dvh] shrink-0 overflow-auto border-b p-4">
            <h3 className="mb-2 text-xs text-muted-foreground">
              Command / input
            </h3>
            <pre className="whitespace-pre-wrap break-words font-mono text-sm [overflow-wrap:anywhere]">
              {terminal.command}
            </pre>
          </div>
        )}
        <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
          <TerminalCodeBlock
            {...terminal}
            status={terminal.isExecuting ? "streaming" : "ready"}
            variant="sidebar"
            wrap={wrap}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
