import { memo } from "react";
import { Streamdown } from "streamdown";
import { CodeHighlight } from "./CodeHighlight";
import { LinkWithTooltip } from "@/components/ui/link-with-tooltip";

export const MemoizedMarkdown = memo(({ content }: { content: string }) => {
  return (
    <Streamdown
      components={{
        code: CodeHighlight,
        a({ children, href, ...props }) {
          if (typeof children === "string" && /^\d+$/.test(children) && href) {
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
      }}
    >
      {content}
    </Streamdown>
  );
});

MemoizedMarkdown.displayName = "MemoizedMarkdown";
