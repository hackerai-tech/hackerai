import React, { useState } from "react";
import { Download, Copy, Check, WrapText } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { toast } from "sonner";

interface CodeActionButtonsProps {
  content: string;
  filename?: string;
  language?: string;
  isWrapped: boolean;
  onToggleWrap: () => void;
  variant?: "sidebar" | "codeblock";
  showDownload?: boolean;
  showCopy?: boolean;
  showWrap?: boolean;
}

export const CodeActionButtons: React.FC<CodeActionButtonsProps> = ({
  content,
  filename,
  language,
  isWrapped,
  onToggleWrap,
  variant = "codeblock",
  showDownload = true,
  showCopy = true,
  showWrap = true,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (variant === "sidebar") {
        toast.success("Code copied to clipboard");
      }
    } catch (error) {
      console.error("Failed to copy code:", error);
      if (variant === "sidebar") {
        toast.error("Failed to copy code");
      }
    }
  };

  const handleDownload = async () => {
    const defaultFilename = filename || `code.${language || "txt"}`;

    try {
      // Try to use the File System Access API for native save dialog
      if ("showSaveFilePicker" in window) {
        const fileHandle = await (
          window as Window & {
            showSaveFilePicker: (options: {
              suggestedName: string;
            }) => Promise<FileSystemFileHandle>;
          }
        ).showSaveFilePicker({
          suggestedName: defaultFilename,
        });

        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        toast.success("File saved successfully");
        return;
      }
    } catch (err) {
      // Don't show toast for user-cancelled save dialogs
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      toast.error("Failed to save file");
      return;
    }

    // Fallback to traditional download
    try {
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(
        variant === "sidebar"
          ? "File downloaded successfully"
          : "File downloaded successfully",
      );
    } catch (error) {
      // Don't show toast for user-cancelled operations
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      toast.error("Failed to download file", {
        description:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };

  const getButtonClasses = () => {
    if (variant === "sidebar") {
      return "inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs transition-colors text-muted-foreground hover:bg-background hover:text-foreground";
    }
    return "p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-secondary text-muted-foreground";
  };

  const getWrapButtonClasses = () => {
    if (variant === "sidebar") {
      return `inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs transition-colors ${
        isWrapped
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-background hover:text-foreground"
      }`;
    }
    return `p-1.5 transition-all rounded hover:bg-secondary text-muted-foreground ${
      isWrapped ? "opacity-100 bg-secondary" : "opacity-70"
    }`;
  };

  return (
    <div
      className={`flex items-center ${variant === "sidebar" ? "gap-0.5" : "space-x-2"}`}
    >
      {showDownload && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleDownload}
              className={getButtonClasses()}
              aria-label="Download"
            >
              <Download size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Download</TooltipContent>
        </Tooltip>
      )}

      {showWrap && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleWrap}
              className={getWrapButtonClasses()}
              aria-label={
                isWrapped ? "Disable text wrapping" : "Enable text wrapping"
              }
            >
              <WrapText size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {isWrapped ? "Disable text wrapping" : "Enable text wrapping"}
          </TooltipContent>
        </Tooltip>
      )}

      {showCopy && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleCopy}
              className={getButtonClasses()}
              aria-label={copied ? "Copied!" : "Copy"}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{copied ? "Copied!" : "Copy"}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
