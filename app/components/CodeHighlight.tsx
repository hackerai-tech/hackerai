import type { ReactNode } from "react";
import { useState, useMemo } from "react";
import ShikiHighlighter, { isInlineCode, type Element } from "react-shiki";
import { CodeActionButtons } from "@/components/ui/code-action-buttons";
import { isLanguageSupported, ShikiErrorBoundary } from "@/lib/utils/shiki";

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

  const [isWrapped, setIsWrapped] = useState(false);

  const isInline: boolean | undefined = node ? isInlineCode(node) : undefined;

  // Check if language is supported by Shiki
  const shouldUsePlainText = useMemo(() => {
    return !isLanguageSupported(language);
  }, [language]);

  const handleToggleWrap = () => {
    setIsWrapped(!isWrapped);
  };

  return !isInline ? (
    <div className="shiki not-prose relative rounded-lg bg-card border border-border my-2 overflow-hidden">
      {/* Menu bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-muted border-b border-border">
        {/* Left side - Language */}
        <div className="flex-1">
          {language && (
            <span className="text-xs tracking-tighter px-2 py-1 rounded text-secondary-foreground">
              {language}
            </span>
          )}
        </div>

        {/* Right side - Action buttons */}
        <CodeActionButtons
          content={codeContent}
          language={language}
          isWrapped={isWrapped}
          onToggleWrap={handleToggleWrap}
          variant="codeblock"
        />
      </div>

      {/* Code content */}
      <div className="overflow-hidden">
        {shouldUsePlainText ? (
          <pre
            className={`shiki not-prose relative bg-card text-sm font-[450] text-card-foreground px-[1em] py-[1em] rounded-none m-0 ${
              isWrapped
                ? "whitespace-pre-wrap break-words overflow-visible"
                : "overflow-x-auto max-w-full"
            }`}
          >
            <code>{codeContent}</code>
          </pre>
        ) : (
          <ShikiErrorBoundary
            fallback={
              <pre
                className={`shiki not-prose relative bg-card text-sm font-[450] text-card-foreground px-[1em] py-[1em] rounded-none m-0 ${
                  isWrapped
                    ? "whitespace-pre-wrap break-words overflow-visible"
                    : "overflow-x-auto max-w-full"
                }`}
              >
                <code>{codeContent}</code>
              </pre>
            }
          >
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
          </ShikiErrorBoundary>
        )}
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
