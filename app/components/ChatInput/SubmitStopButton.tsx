"use client";

import { Button } from "@/components/ui/button";
import { TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ArrowUp, Square } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import type { ChatStatus } from "@/types";
import type { ChatMode } from "@/types/chat";
import type { UploadedFileState } from "@/types/file";

const BASE_BUTTON_CLASSES = "rounded-full p-0 w-8 h-8 min-w-0";

const STOP_BUTTON_VARIANT_CLASSES: Record<ChatMode, string> = {
  agent:
    "bg-red-500/10 hover:bg-red-500/20 text-red-700 dark:bg-red-400/10 dark:hover:bg-red-400/20 dark:text-red-400 focus-visible:ring-red-500",
  "agent-long":
    "bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:bg-amber-400/10 dark:hover:bg-amber-400/20 dark:text-amber-400 focus-visible:ring-amber-500",
  ask: "bg-muted hover:bg-muted/70 text-foreground",
};

function getStopButtonVariantClasses(mode: ChatMode): string {
  return STOP_BUTTON_VARIANT_CLASSES[mode] ?? STOP_BUTTON_VARIANT_CLASSES.ask;
}

function getSubmitButtonVariantClasses(mode: ChatMode): string {
  return mode === "agent"
    ? "bg-red-500/10 hover:bg-red-500/20 text-red-700 dark:bg-red-400/10 dark:hover:bg-red-400/20 dark:text-red-400 focus-visible:ring-red-500"
    : "";
}

function getSendButtonTooltip(
  hasFileErrors: boolean,
  isUploading: boolean,
): string {
  if (hasFileErrors) return "Remove failed files to send";
  if (isUploading) return "File upload pending";
  return "Send (⏎)";
}

export interface SubmitStopButtonProps {
  isGenerating: boolean;
  hideStop: boolean;
  onStop: () => void;
  onSubmit: (e: React.FormEvent) => void;
  status: ChatStatus;
  isUploadingFiles: boolean;
  input: string;
  uploadedFiles: UploadedFileState[];
  chatMode: ChatMode;
  showContextIndicator?: boolean;
}

export function SubmitStopButton({
  isGenerating,
  hideStop,
  onStop,
  onSubmit,
  status,
  isUploadingFiles,
  input,
  uploadedFiles,
  chatMode,
  showContextIndicator = false,
}: SubmitStopButtonProps) {
  useHotkeys(
    "ctrl+c",
    (e) => {
      e.preventDefault();
      onStop();
    },
    {
      enabled: isGenerating && !hideStop,
      enableOnFormTags: true,
      enableOnContentEditable: true,
      preventDefault: true,
      description: "Stop AI generation",
    },
    [isGenerating, onStop],
  );

  const containerClass = `flex gap-2 shrink-0 items-center ${showContextIndicator ? "" : "ml-auto"}`;

  if (isGenerating && !hideStop) {
    return (
      <div className={containerClass}>
        <TooltipPrimitive.Root>
          <TooltipTrigger asChild>
            <Button
              type="button"
              onClick={onStop}
              variant="ghost"
              className={`${BASE_BUTTON_CLASSES} ${getStopButtonVariantClasses(chatMode)}`}
              aria-label="Stop generation"
            >
              <Square className="w-[15px] h-[15px]" fill="currentColor" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Stop (⌃C)</p>
          </TooltipContent>
        </TooltipPrimitive.Root>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      <form onSubmit={onSubmit}>
        <TooltipPrimitive.Root>
          <TooltipTrigger asChild>
            <div className="inline-block">
              <Button
                type="submit"
                disabled={
                  status !== "ready" ||
                  isUploadingFiles ||
                  (!input.trim() && uploadedFiles.length === 0)
                }
                variant="default"
                className={`${BASE_BUTTON_CLASSES} ${getSubmitButtonVariantClasses(chatMode)}`}
                aria-label="Send message"
                data-testid="send-button"
              >
                <ArrowUp size={15} strokeWidth={3} />
              </Button>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>
              {getSendButtonTooltip(
                uploadedFiles.some((f) => f.error),
                isUploadingFiles,
              )}
            </p>
          </TooltipContent>
        </TooltipPrimitive.Root>
      </form>
    </div>
  );
}
