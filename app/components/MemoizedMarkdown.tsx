import { memo } from "react";
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type Components,
  type StreamdownProps,
} from "streamdown";
import { CodeHighlight } from "./CodeHighlight";
import { MarkdownTable } from "./MarkdownTable";
import { SandboxAttachmentLink } from "./SandboxAttachmentLink";
import { isTauriEnvironment, revealFileInDir } from "@/app/hooks/useTauri";
import { rehypeMarkdownDirection } from "@/lib/chat/markdown-direction";
import {
  SANDBOX_ATTACHMENT_HREF_PREFIX,
  remarkSandboxAttachmentLinks,
} from "@/lib/chat/sandbox-attachment-links";
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
  isAnimating?: boolean;
}

const MarkdownLink: NonNullable<Components["a"]> = ({ children, href }) => {
  // dir="auto" isolates link text so a URL or path keeps its slashes in
  // place inside right-to-left prose, while Arabic link text stays RTL.
  if (href?.startsWith(SANDBOX_ATTACHMENT_HREF_PREFIX)) {
    return (
      <span dir="auto">
        <SandboxAttachmentLink href={href}>{children}</SandboxAttachmentLink>
      </span>
    );
  }
  // Local file paths: clickable in Tauri, plain text on web
  if (isLocalFilePath(href)) {
    const decodedPath = decodeURIComponent(href!);
    if (isTauriEnvironment()) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              dir="auto"
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
    return (
      <span dir="auto" className="text-muted-foreground">
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      dir="auto"
      target="_blank"
      rel="noopener noreferrer"
      className="text-link hover:text-link/80 hover:underline transition-colors duration-200"
    >
      {children}
    </a>
  );
};

// Streamdown includes component identity in its per-block memoization check.
// Keep this map stable so appending one block does not re-render completed
// code blocks earlier in the same streaming response.
const MARKDOWN_COMPONENTS: Components = {
  code: CodeHighlight,
  table: MarkdownTable,
  a: MarkdownLink,
};

// Passing remarkPlugins replaces Streamdown's defaults, so keep them first.
// The sandbox rewrite runs before the default rehype sanitize/harden plugins,
// which still check every resulting URL.
const MARKDOWN_REMARK_PLUGINS: NonNullable<StreamdownProps["remarkPlugins"]> = [
  ...Object.values(defaultRemarkPlugins),
  remarkSandboxAttachmentLinks,
];

// Passing rehypePlugins also replaces the defaults (raw HTML, sanitize,
// harden), so keep them first. The direction pass runs last and only adds a
// literal `dir` to top-level blocks, after every URL and attribute check.
const MARKDOWN_REHYPE_PLUGINS: NonNullable<StreamdownProps["rehypePlugins"]> = [
  ...Object.values(defaultRehypePlugins),
  rehypeMarkdownDirection,
];

// Streamdown styles quotes and nested lists with physical left-side classes.
// Mirror them only for right-to-left content so LTR keeps its classes as-is.
// Table headers use `start`, which is `left` in LTR and still yields to a
// column's explicit Markdown alignment (an inline style).
const MARKDOWN_RTL_SIDES =
  "[&_blockquote:is([dir=rtl],[dir=rtl]_*)]:border-l-0 [&_blockquote:is([dir=rtl],[dir=rtl]_*)]:border-r-4 [&_blockquote:is([dir=rtl],[dir=rtl]_*)]:pl-0 [&_blockquote:is([dir=rtl],[dir=rtl]_*)]:pr-4 [&_[dir=rtl]_li_:is(ul,ol)]:pl-0 [&_[dir=rtl]_li_:is(ul,ol)]:pr-6 [&_th]:text-start";

export const MemoizedMarkdown = memo(
  ({ content, isAnimating = false }: MemoizedMarkdownProps) => {
    return (
      <Streamdown
        className={MARKDOWN_RTL_SIDES}
        components={MARKDOWN_COMPONENTS}
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        isAnimating={isAnimating}
      >
        {content}
      </Streamdown>
    );
  },
);

MemoizedMarkdown.displayName = "MemoizedMarkdown";
