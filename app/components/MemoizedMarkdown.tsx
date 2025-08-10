import { marked } from "marked";
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { CodeHighlight } from "./CodeHighlight";
import { Table, Th, Td } from "@/components/ui/table-components";
import { LinkWithTooltip } from "@/components/ui/link-with-tooltip";

const parseMarkdownIntoBlocks = (markdown: string): string[] => {
  const tokens = marked.lexer(markdown);
  return tokens.map((token) => token.raw);
};

const MemoizedMarkdownBlock = memo(
  ({ content }: { content: string }) => {
    return (
      <ReactMarkdown
        components={{
          code: CodeHighlight,
          a({ children, href, ...props }) {
            if (
              typeof children === "string" &&
              /^\d+$/.test(children) &&
              href
            ) {
              return <LinkWithTooltip href={href}>{children}</LinkWithTooltip>;
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
          p({ children }) {
            return (
              <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>
            );
          },
          table: ({ children, ...props }) => {
            return (
              <div className="w-full">
                <Table {...props}>{children}</Table>
              </div>
            );
          },
          th: ({ children, ...props }) => <Th {...props}>{children}</Th>,
          td: ({ children, ...props }) => <Td {...props}>{children}</Td>,
        }}
      >
        {content}
      </ReactMarkdown>
    );
  },
  (prevProps, nextProps) => {
    if (prevProps.content !== nextProps.content) return false;
    return true;
  },
);

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

export const MemoizedMarkdown = memo(
  ({ content, id }: { content: string; id: string }) => {
    const blocks = useMemo(() => parseMarkdownIntoBlocks(content), [content]);

    return (
      <>
        {blocks.map((block, index) => (
          <MemoizedMarkdownBlock content={block} key={`${id}-block_${index}`} />
        ))}
      </>
    );
  },
);

MemoizedMarkdown.displayName = "MemoizedMarkdown";
