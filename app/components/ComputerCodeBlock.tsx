import type { ReactNode } from "react";
import { useState, useMemo } from "react";
import { Download, Copy, Check, WrapText } from "lucide-react";
import ShikiHighlighter from "react-shiki";
import { isLanguageSupported, ShikiErrorBoundary } from "@/lib/utils/shiki";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { toast } from "sonner";

interface ComputerCodeBlockProps {
  children: ReactNode;
  language?: string;
  wrap?: boolean;
  showButtons?: boolean;
}

export const ComputerCodeBlock = ({
  children,
  language,
  wrap = true,
  showButtons = true,
}: ComputerCodeBlockProps) => {
  const codeContent = String(children);
  const [copied, setCopied] = useState(false);
  const [isWrapped, setIsWrapped] = useState(wrap);

  // Check if language is supported by Shiki
  const shouldUsePlainText = useMemo(() => {
    return !isLanguageSupported(language);
  }, [language]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeContent.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy code:", error);
    }
  };

  const handleDownload = async () => {
    const defaultFilename = `code.${language || "txt"}`;

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
        await writable.write(codeContent);
        await writable.close();
        toast.success("File saved successfully");
        return;
      }
    } catch {
      toast.error("Failed to save file");
      return;
    }

    // Fallback to traditional download
    try {
      const blob = new Blob([codeContent], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("File downloaded successfully");
    } catch (error) {
      toast.error("Failed to download file", {
        description:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };

  const handleToggleWrap = () => {
    setIsWrapped(!isWrapped);
  };

  return (
    <div className="shiki not-prose relative h-full w-full bg-transparent overflow-hidden">
      {/* Floating action buttons - only show if showButtons is true */}
      {showButtons && (
        <div className="absolute top-1 right-0 z-10 pl-1 pr-2">
          <div className="backdrop-blur-sm inline-flex h-7 items-center rounded-lg bg-muted/80 p-0.5 border border-border/50">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleDownload}
                  className="inline-flex items-center justify-center rounded-md px-3 py-1 text-xs transition-colors text-muted-foreground hover:bg-background hover:text-foreground"
                  aria-label="Download"
                >
                  <Download size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleToggleWrap}
                  className={`inline-flex items-center justify-center rounded-md px-3 py-1 text-xs transition-colors ${
                    isWrapped
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background hover:text-foreground"
                  }`}
                  aria-label={
                    isWrapped ? "Disable text wrapping" : "Enable text wrapping"
                  }
                >
                  <WrapText size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {isWrapped ? "Disable text wrapping" : "Enable text wrapping"}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleCopy}
                  className="inline-flex items-center justify-center rounded-md px-3 py-1 text-xs transition-colors text-muted-foreground hover:bg-background hover:text-foreground"
                  aria-label={copied ? "Copied!" : "Copy"}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{copied ? "Copied!" : "Copy"}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* Code content - takes full available space */}
      <div className={`h-full w-full overflow-auto bg-background`}>
        {shouldUsePlainText ? (
          <pre
            className={`shiki not-prose relative bg-transparent text-sm font-[450] text-card-foreground h-full w-full px-[0.5em] py-[0.5em] rounded-none m-0 min-h-full min-w-0 ${
              isWrapped
                ? "whitespace-pre-wrap break-words word-break-break-word"
                : "whitespace-pre overflow-x-auto"
            }`}
          >
            <code className="bg-transparent">{codeContent}</code>
          </pre>
        ) : (
          <ShikiErrorBoundary
            fallback={
              <pre
                className={`shiki not-prose relative bg-transparent text-sm font-[450] text-card-foreground h-full w-full px-[0.5em] py-[0.5em] rounded-none m-0 min-h-full min-w-0 ${
                  isWrapped
                    ? "whitespace-pre-wrap break-words word-break-break-word"
                    : "whitespace-pre overflow-x-auto"
                }`}
              >
                <code className="bg-transparent">{codeContent}</code>
              </pre>
            }
          >
            <ShikiHighlighter
              language={language}
              theme="houston"
              delay={150}
              addDefaultStyles={false}
              showLanguage={false}
              className={`shiki not-prose relative bg-transparent text-sm font-[450] text-card-foreground h-full w-full [&_pre]:!bg-transparent [&_pre]:px-[0.5em] [&_pre]:py-[0.5em] [&_pre]:rounded-none [&_pre]:m-0 [&_pre]:h-full [&_pre]:w-full [&_pre]:min-h-full [&_pre]:min-w-0 [&_code]:bg-transparent [&_span]:bg-transparent ${
                isWrapped
                  ? "[&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:word-break-break-word"
                  : "[&_pre]:whitespace-pre [&_pre]:overflow-x-auto"
              }`}
            >
              {codeContent}
            </ShikiHighlighter>
          </ShikiErrorBoundary>
        )}
      </div>
    </div>
  );
};
