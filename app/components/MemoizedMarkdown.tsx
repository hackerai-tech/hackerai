import { memo } from "react";
import { Streamdown } from "streamdown";
import { CodeHighlight } from "./CodeHighlight";

interface MemoizedMarkdownProps {
  content: string;
}

export const MemoizedMarkdown = memo(({ content }: MemoizedMarkdownProps) => {
  return (
    <Streamdown
      components={{
        code: CodeHighlight,
        a({ children, href, ...props }) {
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
      }}
    >
      {content}
    </Streamdown>
  );
});

MemoizedMarkdown.displayName = "MemoizedMarkdown";
