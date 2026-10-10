import { AlertCircle, ArrowRight } from "lucide-react";
import type { SidebarToolError } from "@/types/chat";

export function ToolErrorDetail({ content }: { content: SidebarToolError }) {
  return (
    <div className="h-full overflow-y-auto bg-background font-sans">
      <div
        className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 py-6"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-destructive/20 bg-destructive/10 text-destructive">
            <AlertCircle className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-destructive">
              Needs attention
            </div>
            <h2 className="mt-1 text-base font-semibold text-foreground">
              {content.title}
            </h2>
          </div>
        </div>

        <section aria-labelledby="tool-error-what-happened">
          <h3
            id="tool-error-what-happened"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            What happened
          </h3>
          <p className="mt-2 text-sm leading-6 text-foreground/85">
            {content.summary}
          </p>
          {content.issues && content.issues.length > 0 && (
            <ul className="mt-3 space-y-2" aria-label="Fields to review">
              {content.issues.map((issue) => (
                <li
                  key={`${issue.field}-${issue.problem}`}
                  className="flex items-baseline justify-between gap-4 rounded-lg border border-border/70 bg-muted/15 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 break-words font-medium text-foreground">
                    {issue.field}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {issue.problem}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          className="rounded-xl border border-border bg-muted/20 p-4"
          aria-labelledby="tool-error-next-step"
        >
          <div className="flex items-start gap-3">
            <ArrowRight
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div>
              <h3
                id="tool-error-next-step"
                className="text-sm font-medium text-foreground"
              >
                What to do next
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {content.nextStep}
              </p>
            </div>
          </div>
        </section>

        {content.errorKind === "validation" && (
          <p className="text-xs leading-5 text-muted-foreground">
            For your privacy, generated parameters and raw validation data are
            not shown here.
          </p>
        )}
      </div>
    </div>
  );
}
