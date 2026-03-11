import { memo } from "react";
import { Streamdown } from "streamdown";
import { CodeHighlight } from "./CodeHighlight";
import { MarkdownTable } from "./MarkdownTable";
import { isTauriEnvironment, revealFileInDir } from "@/app/hooks/useTauri";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

/** Local file path: starts with / or ~/ */
function isLocalFilePath(href: string | undefined): boolean {
  if (!href) return false;
  return href.startsWith("/") || href.startsWith("~/");
}

interface MemoizedMarkdownProps {
  content: string;
}

export const MemoizedMarkdown = memo(({ content }: MemoizedMarkdownProps) => {
  return (
    <Streamdown
      components={{
        code: CodeHighlight,
        table: MarkdownTable,
        a({ children, href }) {
          // Local file paths: clickable in Tauri, plain text on web
          if (isLocalFilePath(href)) {
            const decodedPath = decodeURIComponent(href!);
            if (isTauriEnvironment()) {
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => revealFileInDir(decodedPath)}
                      className="text-link hover:text-link/80 hover:underline transition-colors duration-200 cursor-pointer inline"
                    >
                      {children}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{decodedPath}</TooltipContent>
                </Tooltip>
              );
            }
            // Web: render as plain text, not a navigable link
            return <span className="text-muted-foreground">{children}</span>;
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-link hover:text-link/80 hover:underline transition-colors duration-200"
            >
              {children}
            </a>
          );
        },
      }}
    >
      {content}
    </Streamdown>
  );
});

MemoizedMarkdown.displayName = "MemoizedMarkdown";
