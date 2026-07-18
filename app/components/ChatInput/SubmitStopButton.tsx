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

const FREE_STOP_BUTTON_VARIANT_CLASSES: Record<ChatMode, string> = {
  agent:
    "bg-red-500/10 hover:bg-red-500/20 text-red-700 dark:bg-red-400/10 dark:hover:bg-red-400/20 dark:text-red-400 focus-visible:ring-red-500",
  ask: "bg-muted hover:bg-muted/70 text-foreground",
};

const PAID_STOP_BUTTON_VARIANT_CLASSES: Record<ChatMode, string> = {
  agent: "bg-muted hover:bg-muted/70 text-foreground",
  ask: "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:bg-emerald-400/10 dark:hover:bg-emerald-400/20 dark:text-emerald-400 focus-visible:ring-emerald-500",
};

function getStopButtonVariantClasses(mode: ChatMode, isPaid: boolean): string {
  const modeVariantClasses = isPaid
    ? PAID_STOP_BUTTON_VARIANT_CLASSES
    : FREE_STOP_BUTTON_VARIANT_CLASSES;
  return modeVariantClasses[mode] ?? modeVariantClasses.ask;
}

function getSubmitButtonVariantClasses(
  mode: ChatMode,
  isPaid: boolean,
): string {
  if (!isPaid && mode === "agent") {
    return "bg-red-500/10 hover:bg-red-500/20 text-red-700 dark:bg-red-400/10 dark:hover:bg-red-400/20 dark:text-red-400 focus-visible:ring-red-500";
  }
  if (isPaid && mode === "ask") {
    return "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:bg-emerald-400/10 dark:hover:bg-emerald-400/20 dark:text-emerald-400 focus-visible:ring-emerald-500";
  }
  return "";
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
  onSubmit: (e: React.FormEvent) => void | Promise<void>;
  status: ChatStatus;
  isUploadingFiles: boolean;
  input: string;
  uploadedFiles: UploadedFileState[];
  chatMode: ChatMode;
  isPaid?: boolean;
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
  isPaid = false,
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

  const containerClass = "flex gap-2 shrink-0 items-center ml-auto";

  if (isGenerating && !hideStop) {
    return (
      <div className={containerClass}>
        <TooltipPrimitive.Root>
          <TooltipTrigger asChild>
            <Button
              type="button"
              onClick={onStop}
              variant="ghost"
              className={`${BASE_BUTTON_CLASSES} ${getStopButtonVariantClasses(chatMode, isPaid)}`}
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
                className={`${BASE_BUTTON_CLASSES} ${getSubmitButtonVariantClasses(chatMode, isPaid)}`}
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
