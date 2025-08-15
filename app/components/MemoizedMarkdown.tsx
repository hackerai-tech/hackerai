import { marked } from "marked";
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { CodeHighlight } from "./CodeHighlight";
import { Table, Th, Td } from "@/components/ui/table-components";
import { LinkWithTooltip } from "@/components/ui/link-with-tooltip";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeMathjax from "rehype-mathjax";

const parseMarkdownIntoBlocks = (markdown: string): string[] => {
  const tokens = marked.lexer(markdown);
  return tokens.map((token) => token.raw);
};

const MemoizedMarkdownBlock = memo(
  ({ content }: { content: string }) => {
    return (
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          [remarkMath, { singleDollarTextMath: false }],
        ]}
        rehypePlugins={[rehypeMathjax]}
        components={{
          h1({ children }) {
            return (
              <h1 className="text-2xl font-bold mb-4 mt-6 first:mt-0">
                {children}
              </h1>
            );
          },
          h2({ children }) {
            return (
              <h2 className="text-xl font-semibold mb-3 mt-5 first:mt-0">
                {children}
              </h2>
            );
          },
          h3({ children }) {
            return (
              <h3 className="text-lg font-semibold mb-2 mt-4 first:mt-0">
                {children}
              </h3>
            );
          },
          h4({ children }) {
            return (
              <h4 className="text-base font-semibold mb-2 mt-3 first:mt-0">
                {children}
              </h4>
            );
          },
          h5({ children }) {
            return (
              <h5 className="text-sm font-semibold mb-2 mt-3 first:mt-0">
                {children}
              </h5>
            );
          },
          h6({ children }) {
            return (
              <h6 className="text-sm font-medium mb-2 mt-3 first:mt-0">
                {children}
              </h6>
            );
          },
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
                className="text-link hover:text-link/80 hover:underline transition-colors duration-200"
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
