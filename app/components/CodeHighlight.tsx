import type { ReactNode } from "react";
import { useState } from "react";
import { Download, Copy, Check, WrapText } from "lucide-react";
import ShikiHighlighter, { isInlineCode, type Element } from "react-shiki";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { toast } from "sonner";

interface CodeHighlightProps {
  className?: string | undefined;
  children?: ReactNode | undefined;
  node?: Element | undefined;
}

export const CodeHighlight = ({
  className,
  children,
  node,
  ...props
}: CodeHighlightProps) => {
  const match = className?.match(/language-(\w+)/);
  const language = match ? match[1] : undefined;
  const codeContent = String(children);

  const [copied, setCopied] = useState(false);
  const [isWrapped, setIsWrapped] = useState(false);

  const isInline: boolean | undefined = node ? isInlineCode(node) : undefined;

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
        const fileHandle = await (window as Window & { showSaveFilePicker: (options: { suggestedName: string }) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
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

    // Fallback to traditional download (will still show native save dialog on macOS)
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

  return !isInline ? (
    <div className="shiki not-prose relative rounded-lg bg-card border border-border my-2 overflow-hidden">
      {/* Menu bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-muted border-b border-border">
        {/* Left side - Language */}
        {language && (
          <span className="text-xs tracking-tighter px-2 py-1 rounded text-secondary-foreground">
            {language}
          </span>
        )}

        {/* Right side - Action buttons */}
        <div className="flex items-center space-x-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleDownload}
                className="p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-secondary text-muted-foreground"
                aria-label="Download"
              >
                <Download size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleToggleWrap}
                className={`p-1.5 transition-all rounded hover:bg-secondary text-muted-foreground ${
                  isWrapped ? "opacity-100 bg-secondary" : "opacity-70"
                }`}
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

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCopy}
                className="p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-secondary text-muted-foreground"
                aria-label={copied ? "Copied!" : "Copy"}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{copied ? "Copied!" : "Copy"}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Code content */}
      <div className="overflow-hidden">
        <ShikiHighlighter
          language={language}
          theme="houston"
          delay={150}
          addDefaultStyles={false}
          showLanguage={false}
          className={`shiki not-prose relative bg-card text-sm font-[450] text-card-foreground [&_pre]:!bg-transparent [&_pre]:px-[1em] [&_pre]:py-[1em] [&_pre]:rounded-none [&_pre]:m-0 ${
            isWrapped
              ? "[&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:overflow-visible"
              : "[&_pre]:overflow-x-auto [&_pre]:max-w-full"
          }`}
          {...props}
        >
          {codeContent}
        </ShikiHighlighter>
      </div>
    </div>
  ) : (
    <code
      className="bg-muted text-muted-foreground px-1.5 py-0.5 rounded text-sm font-mono"
      {...props}
    >
      {children}
    </code>
  );
};
