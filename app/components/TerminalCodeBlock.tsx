import { useState } from "react";
import { Copy, Check, Download, WrapText, Terminal } from "lucide-react";
import ShikiHighlighter from "react-shiki";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { ShimmerText } from "./ShimmerText";

interface TerminalCodeBlockProps {
  command: string;
  output?: string;
  isExecuting?: boolean;
  status?: "ready" | "submitted" | "streaming" | "error";
}

export const TerminalCodeBlock = ({
  command,
  output,
  isExecuting = false,
  status,
}: TerminalCodeBlockProps) => {
  const [copied, setCopied] = useState(false);
  const [isWrapped, setIsWrapped] = useState(false);

  const handleCopyOutput = async () => {
    if (!output) return;

    try {
      await navigator.clipboard.writeText(output.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy output:", error);
    }
  };

  const handleDownload = async () => {
    const content = output ? `$ ${command}\n${output}` : `$ ${command}`;
    const defaultFilename = "terminal-output.txt";

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
    } catch {
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
    <div className="terminal-codeblock not-prose relative rounded-lg bg-card border border-border my-2 overflow-hidden">
      {/* Terminal command input */}
      <div className="flex items-center justify-between px-4 py-2 bg-secondary border-b border-border">
        <div className="flex items-center space-x-2 flex-1 min-w-0">
          <Terminal size={14} className="text-muted-foreground flex-shrink-0" />
          <code className="text-sm font-mono text-foreground truncate">
            {command}
          </code>
        </div>
      </div>

      {/* Menu bar and output - show if output exists or is executing */}
      {(output || isExecuting) && (
        <>
          <div className="flex items-center justify-between px-4 py-2 bg-muted border-b border-border">
            {/* Left side - Label */}
            <span className="text-xs tracking-tighter px-2 py-1 rounded text-secondary-foreground">
              Output
            </span>

            {/* Right side - Action buttons */}
            <div className="flex items-center space-x-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleDownload}
                    className="p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-secondary text-muted-foreground"
                    aria-label="Download terminal session"
                  >
                    <Download size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Download terminal session</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleToggleWrap}
                    className={`p-1.5 transition-all rounded hover:bg-secondary text-muted-foreground ${
                      isWrapped ? "opacity-100 bg-secondary" : "opacity-70"
                    }`}
                    aria-label={
                      isWrapped
                        ? "Disable text wrapping"
                        : "Enable text wrapping"
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
                    onClick={handleCopyOutput}
                    className="p-1.5 opacity-70 hover:opacity-100 transition-opacity rounded hover:bg-secondary text-muted-foreground"
                    aria-label={copied ? "Output copied!" : "Copy output"}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {copied ? "Output copied!" : "Copy output"}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Terminal output */}
          <div className="overflow-hidden">
            {isExecuting && !output && status === "streaming" ? (
              <div className="px-4 py-4 text-muted-foreground">
                <ShimmerText>Executing command</ShimmerText>
              </div>
            ) : (
              <ShikiHighlighter
                language="ansi"
                theme="houston"
                delay={150}
                addDefaultStyles={false}
                showLanguage={false}
                className={`shiki not-prose relative bg-card text-sm font-mono text-card-foreground [&_pre]:!bg-transparent [&_pre]:px-[1em] [&_pre]:py-[1em] [&_pre]:rounded-none [&_pre]:m-0 ${
                  isWrapped
                    ? "[&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:overflow-visible"
                    : "[&_pre]:overflow-x-auto [&_pre]:max-w-full"
                }`}
              >
                {output || ""}
              </ShikiHighlighter>
            )}
          </div>
        </>
      )}
    </div>
  );
};
