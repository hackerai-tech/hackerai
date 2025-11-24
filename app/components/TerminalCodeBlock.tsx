"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Terminal } from "lucide-react";
import { codeToHtml } from "shiki";
import { Shimmer } from "@/components/ai-elements/shimmer";

interface TerminalCodeBlockProps {
  command: string;
  output?: string;
  isExecuting?: boolean;
  status?: "ready" | "submitted" | "streaming" | "error";
  isBackground?: boolean;
  variant?: "default" | "sidebar";
  wrap?: boolean;
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
  if (ansiCache.size >= MAX_CACHE_SIZE) {
    const entries = Array.from(ansiCache.entries());
    // Remove only the overflow count of oldest entries (FIFO)
    const toRemove = Math.max(0, ansiCache.size - MAX_CACHE_SIZE + 1);
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
            cleanCache();
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
    const heightClasses = "h-full [&_pre]:h-full [&_pre]:flex [&_pre]:flex-col";
    const baseClasses = `shiki not-prose relative bg-transparent text-sm font-[450] text-card-foreground [&_pre]:!bg-transparent [&_pre]:px-[1em] [&_pre]:py-[1em] [&_pre]:rounded-none [&_pre]:m-0 [&_pre]:min-w-0 [&_code]:bg-transparent [&_span]:bg-transparent ${heightClasses} ${
      isWrapped
        ? "[&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:word-break-break-word"
        : "[&_pre]:whitespace-pre [&_pre]:overflow-x-auto [&_pre]:max-w-full"
    }`;
    return className ? `${baseClasses} ${className}` : baseClasses;
  }, [isWrapped, className]);

  // Show loading state for initial render or when switching between very different content
  if (!htmlContent && (isRendering || code)) {
    return (
      <div className="px-4 py-4 text-muted-foreground">
        <Shimmer>
          {isStreaming ? "Processing output..." : "Rendering output..."}
        </Shimmer>
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
  variant = "default",
  wrap = false,
}: TerminalCodeBlockProps) => {
  const [isWrapped, setIsWrapped] = useState(wrap);

  // Update wrapping state when prop changes
  useEffect(() => {
    setIsWrapped(wrap);
  }, [wrap]);

  // Combine command and output for full terminal session
  const terminalContent = output ? `$ ${command}\n${output}` : `$ ${command}`;
  const displayContent = output || "";

  // For non-sidebar variant, keep the original terminal look
  if (variant !== "sidebar") {
    return (
      <div className="terminal-codeblock not-prose relative rounded-lg bg-card border border-border my-2 overflow-hidden flex flex-col h-full">
        {/* Terminal command input */}
        <div className="flex items-center justify-between px-4 py-2 bg-secondary border-b border-border">
          <div className="flex items-center space-x-2 flex-1 min-w-0">
            <Terminal
              size={14}
              className="text-muted-foreground flex-shrink-0"
            />
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

        {/* Terminal output */}
        {(output || isExecuting) && (
          <div className="flex-1 min-h-0 overflow-hidden">
            {isExecuting && !output && status === "streaming" ? (
              <div className="px-4 py-4 text-muted-foreground">
                <Shimmer>Executing command</Shimmer>
              </div>
            ) : (
              <AnsiCodeBlock
                code={displayContent}
                isWrapped={isWrapped}
                isStreaming={status === "streaming" || isExecuting}
                theme="houston"
                delay={150}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  // For sidebar variant, use file block style (no floating buttons since header handles them)
  return (
    <div className="shiki not-prose relative h-full w-full bg-transparent overflow-hidden">
      {/* Terminal content - takes full available space */}
      <div className="h-full w-full overflow-auto bg-background">
        {isExecuting && !output && status === "streaming" ? (
          <div className="px-4 py-4 text-muted-foreground h-full flex items-start">
            <Shimmer>Executing command</Shimmer>
          </div>
        ) : (
          <AnsiCodeBlock
            code={terminalContent}
            isWrapped={isWrapped}
            isStreaming={status === "streaming" || isExecuting}
            theme="houston"
            delay={150}
            className="h-full w-full"
          />
        )}
      </div>
    </div>
  );
};
