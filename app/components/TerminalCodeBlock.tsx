import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Copy, Check, Download, WrapText, Terminal } from "lucide-react";
import { codeToHtml } from "shiki";
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
  isBackground?: boolean;
}

interface AnsiCodeBlockProps {
  code: string;
  isWrapped?: boolean;
  isStreaming?: boolean;
  theme?: string;
  className?: string;
  style?: React.CSSProperties;
  delay?: number;
}

// Cache for rendered ANSI content to avoid re-rendering identical content
const ansiCache = new Map<string, string>();
const MAX_CACHE_SIZE = 100;

// Clean cache when it gets too large
const cleanCache = () => {
  if (ansiCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(ansiCache.entries());
    // Remove oldest half of entries (FIFO)
    const toRemove = Math.floor(MAX_CACHE_SIZE / 2);
    for (let i = 0; i < toRemove; i++) {
      ansiCache.delete(entries[i][0]);
    }
  }
};

/**
 * Optimized ANSI code renderer with streaming support
 * Uses native Shiki codeToHtml with react-shiki patterns for performance
 *
 * Features:
 * - Debounced rendering for streaming content (150ms delay, same as react-shiki)
 * - Caching to avoid re-rendering identical content
 * - Race condition protection for async renders
 * - Memory management with cache cleanup
 * - Proper HTML escaping for fallback content
 * - Follows react-shiki performance patterns
 */
const AnsiCodeBlock = ({
  code,
  isWrapped,
  isStreaming = false,
  theme = "houston",
  className,
  style,
  delay: customDelay,
}: AnsiCodeBlockProps) => {
  const [htmlContent, setHtmlContent] = useState<string>("");
  const [isRendering, setIsRendering] = useState(false);
  const renderTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastRenderedCodeRef = useRef<string>("");
  const cacheKeyRef = useRef<string>("");

  // Debounce rendering for streaming content
  const debouncedRender = useCallback(
    async (codeToRender: string) => {
      // Clear any pending render
      if (renderTimeoutRef.current) {
        clearTimeout(renderTimeoutRef.current);
      }

      // For streaming, debounce rapid updates (same as react-shiki default)
      const delay = customDelay ?? (isStreaming ? 150 : 0);

      renderTimeoutRef.current = setTimeout(async () => {
        // Skip if we've already rendered this exact content
        if (lastRenderedCodeRef.current === codeToRender) {
          return;
        }

        // Create cache key including theme for proper caching
        const cacheKey = `${codeToRender}-${isWrapped}-${theme}`;
        cacheKeyRef.current = cacheKey;

        // Check cache first
        if (ansiCache.has(cacheKey)) {
          setHtmlContent(ansiCache.get(cacheKey)!);
          lastRenderedCodeRef.current = codeToRender;
          return;
        }

        setIsRendering(true);

        try {
          const html = await codeToHtml(codeToRender, {
            lang: "ansi",
            theme: theme,
          });

          // Only update if this is still the current render request
          if (cacheKeyRef.current === cacheKey) {
            setHtmlContent(html);
            ansiCache.set(cacheKey, html);
            lastRenderedCodeRef.current = codeToRender;
          }
        } catch (error) {
          console.error("Failed to render ANSI code:", error);
          // Fallback to plain text with proper escaping
          const escapedCode = codeToRender.replace(/[&<>"']/g, (char) => {
            const entities: Record<string, string> = {
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            };
            return entities[char];
          });
          const fallbackHtml = `<pre><code>${escapedCode}</code></pre>`;

          if (cacheKeyRef.current === cacheKey) {
            setHtmlContent(fallbackHtml);
            cleanCache();
            ansiCache.set(cacheKey, fallbackHtml);
            lastRenderedCodeRef.current = codeToRender;
          }
        } finally {
          setIsRendering(false);
        }
      }, delay);
    },
    [isStreaming, isWrapped, theme, customDelay],
  );

  useEffect(() => {
    if (code) {
      debouncedRender(code);
    } else {
      setHtmlContent("");
      lastRenderedCodeRef.current = "";
    }

    // Cleanup timeout on unmount or code change
    return () => {
      if (renderTimeoutRef.current) {
        clearTimeout(renderTimeoutRef.current);
      }
    };
  }, [code, debouncedRender]);

  // Memoize the className to prevent unnecessary re-calculations (react-shiki pattern)
  const containerClassName = useMemo(() => {
    const baseClasses = `shiki not-prose relative bg-card text-sm font-[450] text-card-foreground [&_pre]:!bg-transparent [&_pre]:px-[1em] [&_pre]:py-[1em] [&_pre]:rounded-none [&_pre]:m-0 ${
      isWrapped
        ? "[&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:overflow-visible"
        : "[&_pre]:overflow-x-auto [&_pre]:max-w-full"
    }`;
    return className ? `${baseClasses} ${className}` : baseClasses;
  }, [isWrapped, className]);

  // Show loading state for initial render or when switching between very different content
  if (!htmlContent && (isRendering || code)) {
    return (
      <div className="px-4 py-4 text-muted-foreground">
        <ShimmerText>
          {isStreaming ? "Processing output..." : "Rendering output..."}
        </ShimmerText>
      </div>
    );
  }

  // Show empty state
  if (!htmlContent && !code) {
    return null;
  }

  return (
    <div
      className={containerClassName}
      style={style}
      dangerouslySetInnerHTML={{ __html: htmlContent }}
    />
  );
};

export const TerminalCodeBlock = ({
  command,
  output,
  isExecuting = false,
  status,
  isBackground = false,
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

      {/* Background process indicator */}
      {isBackground && (
        <div className="px-4 py-3 text-muted-foreground border-b border-border">
          Running in background
        </div>
      )}

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
              <AnsiCodeBlock
                code={output || ""}
                isWrapped={isWrapped}
                isStreaming={status === "streaming" || isExecuting}
                theme="houston"
                delay={150}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
};
